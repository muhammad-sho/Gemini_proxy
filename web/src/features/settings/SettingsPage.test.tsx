// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const updateSettings = vi.fn(async (patch: Record<string, number>) => patch);
const getSettings = vi.fn(async () => ({
  keyFallbackAttempts: 2,
  keyLoopDeadlineMs: 30000,
  requestTimeoutMs: 60000,
  logBodyMaxBytes: 65536,
  maxLogEntries: 1000,
  rateLimitPerMinute: 300,
  clientKeyRatePerMinute: 120
}));

vi.mock("../../api/client.js", () => ({
  api: {
    getSettings,
    updateSettings,
    listAuditLogs: vi.fn(async () => ({ total: 0, actions: [], logs: [] }))
  }
}));
vi.mock("../../auth/useAuth.js", () => ({
  useApp: () => ({ toast: vi.fn(), authed: true, login: vi.fn(), logout: vi.fn() })
}));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const load = async () => (await import("./SettingsPage.js")).SettingsPage;

/** Fields have unique initial values, so query by displayed value. */
function inputFor(initial: string): HTMLInputElement {
  return screen.getByDisplayValue(initial) as HTMLInputElement;
}

describe("SettingsPage clamping", () => {
  it("clamps upstream attempts to the documented maximum", async () => {
    const SettingsPage = await load();
    render(<SettingsPage />);

    await waitFor(() => expect(updateSettings).not.toHaveBeenCalled()); // initial load settles
    const input = inputFor("2");
    fireEvent.change(input, { target: { value: "99" } });
    expect(input.value).toBe("10");
  });

  it("clamps below-minimum values up to the floor", async () => {
    const SettingsPage = await load();
    render(<SettingsPage />);
    await screen.findByText("Routing");

    const input = inputFor("30000"); // total deadline, min 1000
    fireEvent.change(input, { target: { value: "5" } });
    expect(input.value).toBe("1000");
  });

  it("saves the current values through the API", async () => {
    const SettingsPage = await load();
    render(<SettingsPage />);
    await screen.findByText("Routing");

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0][0]).toMatchObject({ keyFallbackAttempts: 2 });
  });
});
