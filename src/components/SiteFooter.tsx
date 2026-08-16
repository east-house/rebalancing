import "./siteFooter.css";

interface SiteFooterProps {
  className?: string;
  note?: string;
}

const FOOTER_LINKS = [
  { href: "/", label: "시장 리포트" },
  { href: "/rebalancing", label: "리밸런싱" },
  { href: "/etf-research", label: "ETF 연구소" },
  { href: "/about", label: "사이트 소개" },
  { href: "/privacy", label: "개인정보처리방침" },
  { href: "/terms", label: "이용약관·투자 유의사항" },
  { href: "/contact", label: "문의" },
] as const;

export default function SiteFooter({ className = "", note }: SiteFooterProps) {
  return (
    <footer className={`site-footer ${className}`.trim()}>
      <div className="site-footer__brand">
        <a href="/" aria-label="TM Reports 홈">TM Reports</a>
        <p>{note ?? "시장을 이해하기 위한 정보와 계산 도구를 제공합니다."}</p>
      </div>
      <nav aria-label="사이트 하단 메뉴">
        {FOOTER_LINKS.map((link) => (
          <a href={link.href} key={link.href}>{link.label}</a>
        ))}
      </nav>
      <p className="site-footer__notice">
        모든 자료는 일반적인 정보 제공 목적이며 특정 금융상품의 매수·매도를 권유하지 않습니다.
        투자 판단과 결과에 대한 책임은 이용자에게 있습니다.
      </p>
      <small>© {new Date().getFullYear()} TM Reports. All rights reserved.</small>
    </footer>
  );
}
