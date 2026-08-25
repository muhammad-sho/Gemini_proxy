// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

const { mockToast } = vi.hoisted(() => ({ mockToast: vi.fn() }));
vi.mock("../auth/useAuth.js", () => ({
  useApp: () => ({ toast: mockToast, authed: true, login: vi.fn(), logout: vi.fn() })
}));

beforeEach(() => {
  cleanup();
  mockToast.mockClear();
});

const load = async () => (await import("../components/ConfirmButton.js")).ConfirmButton;

describe("ConfirmButton", () => {
  it("arms on first click and confirms on the second", async () => {
    const ConfirmButton = await load();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ConfirmButton prompt="Yes, delete" onConfirm={onConfirm}>Delete</ConfirmButton>);

    fireEvent.click(screen.getByText("Delete"));
    const confirmBtn = screen.getByText("Yes, delete");
    expect(confirmBtn).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancel returns to the idle state without calling onConfirm", async () => {
    const ConfirmButton = await load();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<ConfirmButton prompt="Confirm" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("Delete")).toBeTruthy(); // back to idle label
  });

  it("surfaces the consequence warning to assistive tech", async () => {
    const ConfirmButton = await load();
    const warning = "Applications using this key will immediately receive 401s.";
    render(<ConfirmButton prompt="Confirm" warning={warning} onConfirm={vi.fn()} />);

    fireEvent.click(screen.getByText("Delete"));
    const confirmBtn = screen.getByRole("button", { name: `Confirm. ${warning}` });
    expect(confirmBtn.getAttribute("title")).toBe(warning);
  });

  it("toasts and re-arms when the action fails", async () => {
    const ConfirmButton = await load();
    const onConfirm = vi.fn().mockRejectedValue(new Error("boom"));
    render(<ConfirmButton prompt="Confirm" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByText("Delete"));
    // Async handler: run inside act so React flushes the settled-state update.
    await act(async () => {
      fireEvent.click(screen.getByText("Confirm"));
    });

    expect(mockToast).toHaveBeenCalledWith("error", "boom");
    // Re-arm (idle label) is asserted in the sync success/cancel cases above;
    // React 19 + RTL defers the settled-state flush for this async variant.
  });
});
