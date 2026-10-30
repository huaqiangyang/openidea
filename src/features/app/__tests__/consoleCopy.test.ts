import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appActions } from "../appActions";
import { registerActions } from "@/platform/actions";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";
import { installTerminalKeys } from "@/features/terminal/keys";

const writeText = vi.fn().mockResolvedValue(undefined);
const exec = vi.fn();
let cleanup: Array<() => void> = [];

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  document.execCommand = exec;
  useKeymap.setState({ preset: "intellij-windows", overrides: {} });
  cleanup = [registerActions(appActions()), installTerminalKeys(), installKeyboardDispatcher()];
});

afterEach(() => {
  cleanup.reverse().forEach((dispose) => dispose());
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function selectOutput(name: string, role = "log") {
  const output = document.createElement("div");
  output.role = role;
  output.tabIndex = 0;
  output.setAttribute("aria-label", name);
  output.textContent = "prefix selected application output suffix";
  document.body.append(output);
  output.focus();
  const range = document.createRange();
  range.setStart(output.firstChild!, 7);
  range.setEnd(output.firstChild!, 34);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  return output;
}

function copy(target: HTMLElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "c",
    code: "KeyC",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe("console copy through the Windows keymap (#372)", () => {
  it.each(["Run console", "Debug console", "Services output", "Build output"])(
    "copies only selected %s text",
    (name) => {
      const output = selectOutput(name);
      expect(copy(output).defaultPrevented).toBe(true);
      expect(writeText).toHaveBeenCalledWith("selected application output");
      expect(exec).not.toHaveBeenCalled();
    },
  );

  it.each(["intellij-windows", "eclipse-windows", "vscode-windows"])("binds Copy in %s", (preset) => {
    useKeymap.setState({ preset });
    copy(selectOutput("Build message", "document"));
    expect(writeText).toHaveBeenCalledWith("selected application output");
  });

  it("leaves editable selections to their native copy handler", () => {
    selectOutput("old output");
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    copy(input);
    expect(writeText).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("does not write an empty selection", () => {
    const output = selectOutput("Run");
    window.getSelection()!.removeAllRanges();
    copy(output);
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([false, true])("leaves xterm Ctrl+C to terminal handling (Shift=%s)", (shiftKey) => {
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    const input = document.createElement("textarea");
    terminal.append(input);
    document.body.append(terminal);
    input.focus();
    expect(copy(input, { shiftKey }).defaultPrevented).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not change native Cmd+C on the macOS keymap", () => {
    useKeymap.setState({ preset: "intellij-macos" });
    expect(copy(selectOutput("Run"), { ctrlKey: false, metaKey: true }).defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
