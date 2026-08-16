import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SiteInfoPage from "./SiteInfoPage";

describe("AdSense support pages", () => {
  it("discloses Google advertising cookies and privacy choices", () => {
    render(<SiteInfoPage kind="privacy" />);

    expect(screen.getByRole("heading", { name: "개인정보처리방침" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "3. Google 광고와 쿠키" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Google 광고 설정/ }).getAttribute("href"))
      .toBe("https://adssettings.google.com/");
    expect(screen.getByRole("link", { name: "이용약관·투자 유의사항" })).toBeTruthy();
  });

  it("states that calculations are neither advice nor guaranteed returns", () => {
    render(<SiteInfoPage kind="terms" />);

    expect(screen.getByText(/특정 이용자를 위한 투자자문/)).toBeTruthy();
    expect(screen.getByText(/백테스트와 과거 수익률은 미래의 성과를 보장/)).toBeTruthy();
    expect(screen.getByText(/계좌를 연결하거나 주문을 접수/)).toBeTruthy();
  });
});
