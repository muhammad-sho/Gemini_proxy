// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
beforeEach(cleanup);

const load = () => (async () => (await import("../components/Modal.js")).Modal)();

describe("Modal", () => {
  it("renders the title and moves focus into the dialog", async () => {
    const Modal = await load();
    render(<Modal title="Add thing" onClose={() => {}}>
      <button>inner</button>
    </Modal>);
    expect(screen.getByRole("dialog", { name: "Add thing" })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("×"); // close button gets initial focus
  });

  it("closes on Escape", async () => {
    const Modal = await load();
    const onClose = vi.fn();
    render(<Modal title="t" onClose={onClose}><p>body</p></Modal>);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click but not on inside clicks", async () => {
    const Modal = await load();
    const onClose = vi.fn();
    render(<Modal title="t" onClose={onClose}><button>inside</button></Modal>);
    fireEvent.mouseDown(screen.getByText("inside")); // inside → stays open
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!); // backdrop → closes
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab focus inside the dialog", async () => {
    const Modal = await load();
    render(<Modal title="trap" onClose={() => {}}>
      <button>first</button>
      <button>last</button>
    </Modal>);
    const dialog = screen.getByRole("dialog", { name: "trap" });
    const buttons = dialog.querySelectorAll("button");
    const first = buttons[0]; // close ×
    const last = buttons[buttons.length - 1];

    last.focus();
    fireEvent.keyDown(window, { key: "Tab" }); // forward from last wraps to first
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true }); // backward from first wraps to last
    expect(document.activeElement).toBe(last);
  });

  it("restores focus to the previously focused element on unmount", async () => {
    const Modal = await load();
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(<Modal title="restore" onClose={() => {}}><p>x</p></Modal>);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
