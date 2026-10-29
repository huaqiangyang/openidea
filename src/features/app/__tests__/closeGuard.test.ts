import { describe, expect, it, vi } from "vitest";
import { confirmExitEnabled, decideClose, type CloseDeps, type CloseInput } from "../closeGuard";
import type { MessageRequest as PromptRequest, MessageResult as PromptResult } from "@/workbench/messages";

function deps(answers: PromptResult[]) {
  const asked: PromptRequest[] = [];
  const d: CloseDeps = {
    ask: vi.fn(async (r: PromptRequest) => {
      asked.push(r);
      return answers.shift() ?? { button: "cancel", checked: false };
    }),
    saveAll: vi.fn(async () => {}),
    disableConfirmExit: vi.fn(async () => {}),
    onSaveFailed: vi.fn(),
  };
  return { d, asked };
}

const base: CloseInput = { quitting: false, windows: 1, confirmExit: false, dirty: 0, project: "openidea" };

describe("decideClose", () => {
  it("closes silently when nothing needs asking", async () => {
    const { d, asked } = deps([]);
    await expect(decideClose(base, d)).resolves.toBe(true);
    expect(asked).toHaveLength(0);
  });

  it("confirms exit for the last window when enabled", async () => {
    const { d, asked } = deps([{ button: "exit", checked: false }]);
    await expect(decideClose({ ...base, confirmExit: true }, d)).resolves.toBe(true);
    expect(asked[0]?.title).toBe("Confirm Exit");
    expect(d.disableConfirmExit).not.toHaveBeenCalled();
  });

  it("cancelling the exit prompt keeps the window", async () => {
    const { d } = deps([{ button: "cancel", checked: false }]);
    await expect(decideClose({ ...base, confirmExit: true }, d)).resolves.toBe(false);
  });

  it("'don't ask again' turns the setting off", async () => {
    const { d } = deps([{ button: "exit", checked: true }]);
    await decideClose({ ...base, confirmExit: true }, d);
    expect(d.disableConfirmExit).toHaveBeenCalled();
  });

  it("does not confirm exit for one of several windows or during quit", async () => {
    const { d, asked } = deps([]);
    await decideClose({ ...base, confirmExit: true, windows: 2 }, d);
    await decideClose({ ...base, confirmExit: true, quitting: true }, d);
    expect(asked).toHaveLength(0);
  });

  it("saves all on Save", async () => {
    const { d, asked } = deps([{ button: "save", checked: false }]);
    await expect(decideClose({ ...base, dirty: 2 }, d)).resolves.toBe(true);
    expect(asked[0]?.body).toBe("2 files have unsaved changes in openidea. Save before closing?");
    expect(d.saveAll).toHaveBeenCalled();
  });

  it("discards without saving", async () => {
    const { d } = deps([{ button: "discard", checked: false }]);
    await expect(decideClose({ ...base, dirty: 1, quitting: true }, d)).resolves.toBe(true);
    expect(d.saveAll).not.toHaveBeenCalled();
  });

  it("keeps the window when saving fails or the user cancels", async () => {
    const failing = deps([{ button: "save", checked: false }]);
    failing.d.saveAll = vi.fn(async () => {
      throw new Error("disk full");
    });
    await expect(decideClose({ ...base, dirty: 1 }, failing.d)).resolves.toBe(false);
    expect(failing.d.onSaveFailed).toHaveBeenCalled();
    const cancel = deps([{ button: "cancel", checked: false }]);
    await expect(decideClose({ ...base, dirty: 1 }, cancel.d)).resolves.toBe(false);
  });

  it("reads general.confirmExit", () => {
    expect(confirmExitEnabled({ general: { confirmExit: true } })).toBe(true);
    expect(confirmExitEnabled({ general: {} })).toBe(false);
    expect(confirmExitEnabled(null)).toBe(false);
  });
});

it("includes pending local edits and restored dirty buffers before backend dirty events", async () => {
  const service = await import("@/workbench/contributions");
  const { dirtyCount, _setDirtyForTests } = await import("../closeGuard");
  const spy = vi.spyOn(service, "maybeEditorService").mockReturnValue({ dirtyDocumentIds: () => [10, 11] } as never);
  try {
    _setDirtyForTests([11, 12]);
    expect(dirtyCount()).toBe(3);
  } finally {
    _setDirtyForTests([]);
    spy.mockRestore();
  }
});
