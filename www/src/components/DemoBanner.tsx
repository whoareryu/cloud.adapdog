// 포트폴리오 시연용 배너 — 이 화면이 해커톤 참가작 목업임을 밝히고,
// 데모 백엔드(맥 도커 + 터널)가 꺼져 있으면 소개 사이트로 안내한다.
// 터널이 꺼지면 Cloudflare 가 530 HTML 을 주므로 개별 API 오류가 아니라 헬스체크로 판정한다.
// 이 앱은 Tailwind 를 로드하지 않으므로(index.css 미임포트) 스타일은 인라인으로 둔다.
import { useEffect, useState } from 'react';
import { checkHealth } from '../api/client';

const SITE_URL = 'https://adapdog.whoareryu.cloud';
const HEALTH_TIMEOUT_MS = 6000;

function healthWithTimeout(): Promise<boolean> {
  return Promise.race([
    checkHealth(),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), HEALTH_TIMEOUT_MS)),
  ]);
}

export default function DemoBanner() {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    healthWithTimeout().then((ok) => {
      if (alive) setOnline(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div
      role="status"
      style={{
        flex: 'none',
        background: '#171717',
        color: '#fff',
        padding: '8px 16px',
        textAlign: 'center',
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      <span style={{ fontWeight: 600 }}>해커톤 참가작 목업</span> — 실제 데이터·AI 미연결
      {online === false ? (
        <span style={{ color: '#fcd34d' }}>
          {' '}· 데모 서버가 잠시 꺼져 있습니다 —{' '}
          <a style={{ color: 'inherit', textDecoration: 'underline' }} href={SITE_URL}>
            소개 사이트에서 화면 캡처 보기
          </a>
        </span>
      ) : null}
    </div>
  );
}
