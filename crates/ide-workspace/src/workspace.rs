//! A workspace owns its settings and references project folders without changing them.
use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const FILE: &str = ".openidea/workspace.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub version: u32,
    pub name: String,
    #[serde(serialize_with = "serialize_projects")]
    #[specta(type = Vec<String>)]
    pub projects: Vec<PathBuf>,
}

fn serialize_projects<S: serde::Serializer>(projects: &[PathBuf], serializer: S) -> Result<S::Ok, S::Error> {
    projects.iter().map(|path| ide_core::ipc_path::to_ipc(path)).collect::<Vec<_>>().serialize(serializer)
}

impl Workspace {
    pub fn load(root: &Path) -> IdeResult<Option<Self>> {
        let bytes = match std::fs::read(root.join(FILE)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let mut workspace: Self =
            serde_json::from_slice(&bytes).map_err(|e| IdeError::invalid(format!("Invalid workspace: {e}")))?;
        if workspace.version != 1 {
            return Err(IdeError::invalid("Unsupported workspace version"));
        }
        workspace.name = valid_name(&workspace.name)?;
        workspace.projects = normalize_projects(root, workspace.projects, true)?;
        Ok(Some(workspace))
    }

    pub fn save(root: &Path, name: &str, projects: Vec<PathBuf>, create: bool) -> IdeResult<Self> {
        let name = valid_name(name)?;
        let root = destination(root)?;
        let previous = Self::load(&root)?;
        if create && previous.is_some() {
            return Err(IdeError::invalid("This folder already contains a workspace"));
        }
        if !create && previous.is_none() {
            return Err(IdeError::invalid("This folder is not a workspace"));
        }
        let projects = normalize_projects(&root, projects, true)?;
        for path in &projects {
            if !path.is_dir() && !previous.as_ref().is_some_and(|w| w.projects.contains(path)) {
                return Err(IdeError::invalid(format!("Project folder does not exist: {}", path.display())));
            }
        }
        if projects.iter().any(|p| p == &root || root.starts_with(p)) {
            return Err(IdeError::invalid("Store the workspace outside its linked project folders"));
        }
        std::fs::create_dir_all(&root)?;
        let workspace = Self { version: 1, name, projects };
        let bytes = serde_json::to_vec_pretty(&workspace).map_err(|e| IdeError::internal(e.to_string()))?;
        let file = root.join(FILE);
        std::fs::create_dir_all(file.parent().expect("workspace metadata directory"))?;
        if create {
            std::fs::OpenOptions::new().write(true).create_new(true).open(file)?.write_all(&bytes)?;
        } else {
            ide_vfs::write_atomic(&file, &bytes)?;
        }
        Ok(workspace)
    }
}

fn destination(path: &Path) -> IdeResult<PathBuf> {
    if !path.is_absolute() {
        return Err(IdeError::invalid("Choose an absolute workspace location"));
    }
    if path.exists() {
        return Ok(dunce::canonicalize(path)?);
    }
    let parent = path.parent().ok_or_else(|| IdeError::invalid("Invalid workspace location"))?;
    let name = path.file_name().ok_or_else(|| IdeError::invalid("Invalid workspace location"))?;
    Ok(destination(parent)?.join(name))
}

fn valid_name(name: &str) -> IdeResult<String> {
    let name = name.trim();
    if name.is_empty() || name.contains(['\n', '\r']) {
        return Err(IdeError::invalid("Enter a workspace name"));
    }
    Ok(name.to_owned())
}

fn normalize_projects(root: &Path, projects: Vec<PathBuf>, allow_missing: bool) -> IdeResult<Vec<PathBuf>> {
    let mut result = Vec::new();
    for path in projects {
        let path = if path.is_absolute() { path } else { root.join(path) };
        let path = match dunce::canonicalize(&path) {
            Ok(path) if path.is_dir() => path,
            Err(e) if allow_missing && e.kind() == std::io::ErrorKind::NotFound => path,
            _ => return Err(IdeError::invalid(format!("Project folder does not exist: {}", path.display()))),
        };
        if path.join(FILE).exists() {
            return Err(IdeError::invalid("Add project folders instead of nesting workspaces"));
        }
        if !result.contains(&path) {
            result.push(path);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_deduplicates_projects_without_changing_them() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let root = tmp.path().join("workspace");
        let saved = Workspace::save(&root, " Full stack ", vec![project.clone(), project.clone()], true).unwrap();
        assert_eq!(saved.projects.len(), 1);
        assert_eq!(Workspace::load(&root).unwrap(), Some(saved));
        assert!(!project.join(".openidea").exists());
        assert!(Workspace::save(&root, "Other", vec![], true).is_err());
        assert_eq!(Workspace::load(&root).unwrap().unwrap().name, "Full stack");
    }

    #[test]
    fn invalid_update_leaves_manifest_intact_and_missing_projects_can_reopen() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let root = tmp.path().join("workspace");
        Workspace::save(&root, "Workspace", vec![project.clone()], true).unwrap();
        let before = std::fs::read(root.join(FILE)).unwrap();
        assert!(Workspace::save(&root, "Changed", vec![tmp.path().join("missing")], false).is_err());
        assert_eq!(std::fs::read(root.join(FILE)).unwrap(), before);
        std::fs::remove_dir(project).unwrap();
        assert_eq!(Workspace::load(&root).unwrap().unwrap().projects.len(), 1);
        let missing = Workspace::load(&root).unwrap().unwrap().projects;
        Workspace::save(&root, "Renamed", missing, false).unwrap();
    }

    #[test]
    fn invalid_location_does_not_create_a_folder_inside_a_project() {
        let tmp = tempfile::tempdir().unwrap();
        let project = dunce::canonicalize(tmp.path()).unwrap();
        let root = project.join("workspace");
        assert!(Workspace::save(&root, "Invalid", vec![project], true).is_err());
        assert!(!root.exists());
    }
}
