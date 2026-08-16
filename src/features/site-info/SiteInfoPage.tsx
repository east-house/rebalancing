import { ArrowLeft, ExternalLink, Mail, ShieldCheck } from "lucide-react";

import SiteFooter from "../../components/SiteFooter";
import "./siteInfoPage.css";

export type SiteInfoKind = "about" | "privacy" | "terms" | "contact";

interface SiteInfoPageProps {
  kind: SiteInfoKind;
}

const CONTACT_EMAIL = "ohsky0218@gmail.com";
const EFFECTIVE_DATE = "2026년 8월 17일";

function ContactAddress() {
  return <a className="info-contact-link" href={`mailto:${CONTACT_EMAIL}`}><Mail size={17} />{CONTACT_EMAIL}</a>;
}

function AboutContent() {
  return (
    <>
      <section>
        <h2>TM Reports가 제공하는 것</h2>
        <p>TM Reports는 미국 시장의 흐름과 위험선호, 섹터·테마 리더십, 거시경제 일정과 관련 뉴스를 한 화면에서 해석할 수 있도록 정리하는 독립 정보 서비스입니다. 포트폴리오 관리, 5종목 모델 보고서와 ETF 비교 도구는 이용자가 직접 입력하거나 선택한 조건을 브라우저에서 계산하고 확인할 수 있게 돕습니다.</p>
      </section>
      <section>
        <h2>콘텐츠 작성 원칙</h2>
        <ul>
          <li>단순 시세 나열 대신 수익률, 이동평균, 시장 폭과 상대강도 등을 계산해 맥락을 제공합니다.</li>
          <li>경제 일정은 공식 발표 일정과 구분하고, 뉴스는 원문 링크와 실제 가격 반응을 함께 확인합니다.</li>
          <li>자료 기준일과 데이터 품질 상태를 화면에 표시하며, 확인할 수 없는 값은 추정해 채우지 않습니다.</li>
          <li>오류가 확인되면 데이터 또는 설명을 정정하고 이후 발행 자료에 반영합니다.</li>
        </ul>
      </section>
      <section>
        <h2>업데이트와 한계</h2>
        <p>시장 리포트는 한국시간 월요일부터 금요일까지 오전 7시 30분에 실행 당일 날짜로 생성됩니다. 주말에는 새 리포트를 생성하지 않으며, 월요일과 미국 휴장일 다음 평일에는 가장 최근에 확인된 미국 거래일 자료가 사용될 수 있습니다. 가격과 경제지표는 제공처의 갱신 시점, 휴장, 네트워크 상태에 따라 지연되거나 누락될 수 있습니다.</p>
      </section>
      <section>
        <h2>독립성</h2>
        <p>TM Reports는 증권사·거래소·상장회사와 제휴된 주문 서비스가 아니며, 계좌 연결이나 자동주문을 제공하지 않습니다. 광고가 표시되더라도 광고주의 상품을 별도로 추천하거나 보증한다는 의미가 아닙니다.</p>
      </section>
    </>
  );
}

function PrivacyContent() {
  return (
    <>
      <p className="info-effective">시행일: {EFFECTIVE_DATE}</p>
      <section>
        <h2>1. 적용 범위와 기본 원칙</h2>
        <p>이 방침은 TM Reports 웹사이트 이용 과정에서 처리되는 정보에 적용됩니다. 서비스는 회원가입을 받지 않으며, 이용자가 포트폴리오 관리·보고서 화면에 입력하거나 저장한 보유 종목·수량·평단가·목표 비중·투자금과 계산 이력은 원칙적으로 해당 브라우저의 로컬 저장소에만 보관됩니다.</p>
      </section>
      <section>
        <h2>2. 처리될 수 있는 정보</h2>
        <ul>
          <li><strong>브라우저 저장 정보:</strong> 포트폴리오 입력값, 모델 제안 반영 기록, 화면 설정과 계산 이력. 사이트 서버로 전송하지 않으며 이용자가 화면의 삭제 기능이나 브라우저 설정으로 지울 수 있습니다.</li>
          <li><strong>시세 요청 정보:</strong> 과거 가격을 요청할 때 국가 코드와 공개 종목 티커가 서버에 전달됩니다. 수량·평단가·목표 비중·투자금은 포함되지 않습니다.</li>
          <li><strong>접속 정보:</strong> 사이트 제공, 보안, 오류 대응 과정에서 IP 주소, 브라우저 정보, 요청 시각과 URL 같은 통상적인 접속 기록이 호스팅·보안 제공업체에 의해 처리될 수 있습니다.</li>
          <li><strong>문의 정보:</strong> 이메일로 문의하면 회신과 분쟁 대응을 위해 이메일 주소와 문의 내용을 처리할 수 있습니다.</li>
        </ul>
      </section>
      <section>
        <h2>3. Google 광고와 쿠키</h2>
        <p>Google AdSense가 활성화되면 Google을 포함한 제3자 광고 사업자가 쿠키, 웹 비콘, IP 주소 또는 기타 식별자를 사용하여 이 사이트나 다른 사이트의 방문 기록을 바탕으로 광고를 게재하고 광고 성과를 측정할 수 있습니다. 광고 쿠키를 이용한 맞춤 광고는 <a href="https://adssettings.google.com/" target="_blank" rel="noreferrer">Google 광고 설정<ExternalLink size={13} /></a>에서 관리할 수 있습니다.</p>
        <p>Google이 파트너 사이트에서 수집한 정보를 사용하는 방법은 <a href="https://policies.google.com/technologies/partner-sites?hl=ko" target="_blank" rel="noreferrer">Google의 파트너 사이트 데이터 사용 안내<ExternalLink size={13} /></a>에서 확인할 수 있습니다.</p>
      </section>
      <section>
        <h2>4. 외부 처리와 국외 처리 가능성</h2>
        <p>서비스 제공에는 Cloudflare의 호스팅·보안 기능이 사용되며, 광고가 활성화되면 Google의 광고·동의 관리 기능이 사용됩니다. 각 사업자는 자체 정책과 계약에 따라 여러 국가의 서버에서 정보를 처리할 수 있습니다. 구체적인 처리 위치와 보유 기간은 각 사업자의 정책 및 이용자 동의 설정에 따릅니다.</p>
      </section>
      <section>
        <h2>5. 보유 기간과 이용자의 선택</h2>
        <p>브라우저 로컬 정보는 이용자가 삭제하거나 브라우저 데이터를 초기화할 때까지 보관됩니다. 문의 기록은 회신과 분쟁 대응에 필요한 기간 동안 보관한 뒤 삭제합니다. 광고 동의가 필요한 지역에서는 Google AdSense의 인증된 동의 관리 플랫폼(CMP)을 통해 동의, 거부 및 설정 변경 수단을 제공합니다.</p>
      </section>
      <section>
        <h2>6. 아동의 개인정보</h2>
        <p>이 서비스는 만 14세 미만 아동을 대상으로 설계되지 않았으며, 아동의 개인정보를 의도적으로 수집하지 않습니다.</p>
      </section>
      <section>
        <h2>7. 문의와 방침 변경</h2>
        <p>개인정보 열람·정정·삭제 또는 기타 문의는 아래 연락처로 요청할 수 있습니다. 중요한 변경이 있으면 시행일과 변경 내용을 이 페이지에 반영합니다.</p>
        <ContactAddress />
      </section>
    </>
  );
}

function TermsContent() {
  return (
    <>
      <p className="info-effective">시행일: {EFFECTIVE_DATE}</p>
      <section className="info-callout">
        <ShieldCheck size={19} />
        <p><strong>핵심 투자 유의사항</strong> 이 사이트의 모든 자료와 계산 결과는 일반적인 정보 제공 및 학습 보조 목적입니다. 특정 이용자를 위한 투자자문, 투자권유, 매매 신호 또는 수익 보장이 아닙니다.</p>
      </section>
      <section>
        <h2>1. 이용자의 판단과 책임</h2>
        <p>금융상품의 가격은 변동하며 원금 손실이 발생할 수 있습니다. 실제 투자 여부, 상품 선택, 주문 시점과 수량은 이용자가 자신의 재무상태와 위험 감수 수준을 고려해 독립적으로 결정해야 합니다. 필요하면 자격을 갖춘 금융·세무·법률 전문가와 상담하시기 바랍니다.</p>
      </section>
      <section>
        <h2>2. 자료와 계산의 한계</h2>
        <ul>
          <li>가격, 지표, 일정과 뉴스는 지연·누락·오류 또는 사후 정정이 있을 수 있습니다.</li>
          <li>리밸런싱 수량과 비용은 화면에 표시된 가정에 따른 예상치이며 실제 체결가, 세금, 환율, 호가 차이와 다를 수 있습니다.</li>
          <li>포트폴리오 보고서의 매수·매도·유지 표시는 고정된 규칙으로 계산한 모델 결과이며 이용자의 보유계좌나 재무상태를 반영한 개인별 주문 지시가 아닙니다.</li>
          <li>백테스트와 과거 수익률은 미래의 성과를 보장하거나 예측하지 않습니다.</li>
          <li>리포트의 분류·점수·해석은 공개 자료를 가공한 분석 결과이며 사실과 의견을 구분해 읽어야 합니다.</li>
        </ul>
      </section>
      <section>
        <h2>3. 주문과 고객 자산</h2>
        <p>TM Reports는 증권계좌를 연결하거나 주문을 접수·전송·집행하지 않습니다. 이용자의 자금을 보관하거나 금융상품 거래의 상대방 또는 중개인이 되지 않습니다.</p>
      </section>
      <section>
        <h2>4. 외부 자료와 링크</h2>
        <p>제3자 자료, 상표와 링크의 권리는 각 권리자에게 있습니다. 외부 링크는 출처 확인을 돕기 위한 것이며 해당 사이트의 내용, 보안 또는 지속적인 이용 가능성을 보증하지 않습니다.</p>
      </section>
      <section>
        <h2>5. 서비스 변경과 책임 범위</h2>
        <p>서비스는 데이터 제공처, 기술적 상황 또는 운영 정책에 따라 일부 변경·중단될 수 있습니다. 운영자는 고의 또는 중대한 과실이 없는 한, 이용자가 정보나 계산 결과에 의존해 내린 결정으로 발생한 손실에 대해 관련 법령이 허용하는 범위에서 책임을 제한합니다.</p>
      </section>
      <section>
        <h2>6. 문의</h2>
        <ContactAddress />
      </section>
    </>
  );
}

function ContactContent() {
  return (
    <>
      <section>
        <h2>문의할 수 있는 내용</h2>
        <p>사이트 오류, 데이터 표시 문제, 정정 요청, 개인정보 관련 요청, 저작권 또는 광고 관련 문의를 받습니다. 투자 종목 추천이나 개인별 매매 판단 요청에는 답변하지 않습니다.</p>
      </section>
      <section>
        <h2>이메일 문의</h2>
        <ContactAddress />
        <p className="info-secondary">문의 시 비밀번호, 계좌번호, 주민등록번호, 실제 보유 수량과 같은 민감한 정보는 보내지 마세요. 오류 문의에는 문제가 발생한 화면 주소, 발생 시각과 브라우저 종류를 포함하면 확인에 도움이 됩니다.</p>
      </section>
      <section>
        <h2>정정 원칙</h2>
        <p>재현 가능한 데이터 오류나 설명 오류는 원자료와 계산 과정을 확인한 후 수정합니다. 외부 제공처 자체의 오류나 지연은 즉시 수정할 수 없으며, 확인된 범위와 한계를 안내합니다.</p>
      </section>
    </>
  );
}

const PAGE_META: Record<SiteInfoKind, { eyebrow: string; title: string; description: string }> = {
  about: {
    eyebrow: "ABOUT TM REPORTS",
    title: "사이트 소개",
    description: "TM Reports가 시장 자료를 정리하고 해석하는 방식과 운영 원칙을 안내합니다.",
  },
  privacy: {
    eyebrow: "PRIVACY POLICY",
    title: "개인정보처리방침",
    description: "브라우저 저장 정보, 접속 정보와 Google 광고 쿠키의 처리 방식을 안내합니다.",
  },
  terms: {
    eyebrow: "TERMS & DISCLAIMER",
    title: "이용약관·투자 유의사항",
    description: "서비스 이용 조건과 금융정보·계산 결과를 해석할 때 확인해야 할 한계를 안내합니다.",
  },
  contact: {
    eyebrow: "CONTACT",
    title: "문의",
    description: "오류, 정정, 개인정보, 저작권과 광고 관련 문의 방법을 안내합니다.",
  },
};

export default function SiteInfoPage({ kind }: SiteInfoPageProps) {
  const meta = PAGE_META[kind];
  return (
    <div className="site-info-shell">
      <header className="site-info-topbar">
        <a href="/"><ArrowLeft size={16} />시장 리포트</a>
        <strong>TM Reports</strong>
        <a href="/rebalancing">리밸런싱</a>
      </header>
      <main className="site-info-main">
        <header className="site-info-hero">
          <span>{meta.eyebrow}</span>
          <h1>{meta.title}</h1>
          <p>{meta.description}</p>
        </header>
        <article className="site-info-article">
          {kind === "about" ? <AboutContent /> : null}
          {kind === "privacy" ? <PrivacyContent /> : null}
          {kind === "terms" ? <TermsContent /> : null}
          {kind === "contact" ? <ContactContent /> : null}
        </article>
        <SiteFooter />
      </main>
    </div>
  );
}
