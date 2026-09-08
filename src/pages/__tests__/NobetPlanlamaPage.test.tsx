import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../DutyPlanFeasibilityPage", () => ({
  default: ({ embedded }: { embedded?: boolean }) => <div data-testid="analysis-page">Analiz {embedded ? "gömülü" : "tam"}</div>,
}));

vi.mock("../OtomatikNobetPlaniPage", () => ({
  default: ({ embedded, onPublished }: { embedded?: boolean; onPublished?: () => void }) => (
    <div data-testid="draft-page">
      Taslak {embedded ? "gömülü" : "tam"}
      <button type="button" onClick={onPublished}>Test yayımla</button>
    </div>
  ),
}));

vi.mock("../HaftalikNobetPlaniPage", () => ({
  default: ({ embedded, onOpenDraft }: { embedded?: boolean; onOpenDraft?: () => void }) => (
    <div data-testid="published-page">
      Yayın {embedded ? "gömülü" : "tam"}
      <button type="button" onClick={onOpenDraft}>Test taslağa dön</button>
    </div>
  ),
}));

import NobetPlanlamaPage from "../NobetPlanlamaPage";

afterEach(cleanup);

describe("NobetPlanlamaPage", () => {
  it("tek çalışma alanını hazırlık aşamasında açar", () => {
    render(<NobetPlanlamaPage />);

    expect(screen.getByRole("heading", { name: "Nöbet Planlama" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Hazırlık/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("analysis-page")).toHaveTextContent("gömülü");
    expect(screen.queryByTestId("draft-page")).not.toBeInTheDocument();
  });

  it("aşama sekmeleri aynı route içinde görünümü değiştirir", async () => {
    const user = userEvent.setup();
    render(<NobetPlanlamaPage />);

    await user.click(screen.getByRole("tab", { name: /Taslak/i }));
    expect(screen.getByTestId("draft-page")).toBeInTheDocument();
    expect(screen.queryByTestId("analysis-page")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Plan geçmişi/i }));
    expect(screen.getByTestId("published-page")).toBeInTheDocument();
  });

  it("eski URL yönlendirmeleri için başlangıç aşamasını kabul eder", () => {
    render(<NobetPlanlamaPage initialView="published" />);
    expect(screen.getByRole("tab", { name: /Plan geçmişi/i })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("published-page")).toHaveTextContent("gömülü");
  });

  it("taslak yayımlanınca yayımlanan plan aşamasına geçer", async () => {
    const user = userEvent.setup();
    render(<NobetPlanlamaPage initialView="draft" />);

    await user.click(screen.getByRole("button", { name: "Test yayımla" }));
    expect(screen.getByTestId("published-page")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Plan geçmişi/i })).toHaveAttribute("aria-selected", "true");
  });

  it("yayımlanmış planın boş durumundan taslak aşamasına döner", async () => {
    const user = userEvent.setup();
    render(<NobetPlanlamaPage initialView="published" />);

    await user.click(screen.getByRole("button", { name: "Test taslağa dön" }));
    expect(screen.getByTestId("draft-page")).toBeInTheDocument();
  });
});
