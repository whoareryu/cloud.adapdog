// 발자국 — standalone 시안 1:1 포팅. 데스크톱 윈도우 앱(상단 네비 + 3패널 플래너 +
// 둘러보기/여정/내 강아지 + 응급 모달 + 다크모드 + 모바일 반응형). 로직은 usePlannerApp.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { css } from './lib/css';
import { transportLabel, journeyOrigin, journeyTransit, KTX_CORRIDOR, JEONJU_ANCHOR, type Place, type TransportCode } from './lib/places';
import { usePlannerApp, type CourseAddStop } from './hooks/usePlannerApp';
import { Emergency } from './components/Emergency';
import { Explore } from './screens/Explore';
import { NaverMap } from './components/NaverMap';
import { fetchDrivingRoute } from './lib/routing';
import { getReviews, checkEntry, getVisitedPlaces, checkSafety, searchPlaces } from './api/endpoints';
import type { Review, RoutePlanResponse, RouteStop, LodgingPlace, EntryVerdictResult, VisitedPlace, SafetyAlertResult } from './api/types';

const GRADS = [
  'linear-gradient(135deg,#F6D9A6,#E7B776)', 'linear-gradient(135deg,#C9B6E4,#A98FD0)',
  'linear-gradient(135deg,#A9C7E8,#7FA8D8)', 'linear-gradient(135deg,#BFD3F0,#8FAEE0)',
  'linear-gradient(135deg,#E7D2A6,#D2B16E)', 'linear-gradient(135deg,#F4C6BE,#E89B8E)',
  'linear-gradient(135deg,#CDE6C2,#94C39C)',
];
const LIVE_ICON: Record<string, string> = { 박물관: 'museum', 미술관: 'palette', 문예회관: 'theater_comedy', 여행지: 'landscape', 식당: 'restaurant', 숙박: 'hotel', 카페: 'local_cafe', 공원: 'park', 관광지: 'photo_camera' };
const liveIcon = (cat: string) => Object.keys(LIVE_ICON).find((k) => cat.includes(k)) ? LIVE_ICON[Object.keys(LIVE_ICON).find((k) => cat.includes(k))!] : 'pets';

// 코스가 비었을 때 상세 패널이 참조할 빈 Place(좌표 0 — '코스 없음' 안내로 분기됨).
const FALLBACK_PLACE: Place = {
  key: 'village', name: '전주', cat: '여행지', rating: '', price: '', hours: '', loc: '전주',
  day: '', time: '', icon: 'pets', grad: GRADS[0], label: '전주', desc: '', badges: [],
  entry: '', entryNote: '', source: '', mx: 50, my: 50, latitude: 0, longitude: 0, popular: [],
};

// 백엔드 RoutePlanResponse → 시안 Place 형태(지도 좌표 정규화 + 그라데이션 배정).
function mapCourse(course: RoutePlanResponse | null): Place[] {
  const stops = course?.stops?.slice(0, 8) ?? [];
  if (!stops.length) return [];
  const lats = stops.map((s) => s.latitude), lngs = stops.map((s) => s.longitude);
  const minLa = Math.min(...lats), maxLa = Math.max(...lats), minLo = Math.min(...lngs), maxLo = Math.max(...lngs);
  const nx = (lo: number) => (maxLo === minLo ? 50 : 14 + ((lo - minLo) / (maxLo - minLo)) * 72);
  const ny = (la: number) => (maxLa === minLa ? 50 : 84 - ((la - minLa) / (maxLa - minLa)) * 66);
  return stops.map((s, i) => ({
    key: 'L' + i, name: s.name, cat: s.category, rating: '', price: '', hours: '', loc: s.category,
    day: `${i + 1}번째 코스`, time: '', icon: liveIcon(s.category), grad: GRADS[i % GRADS.length], label: s.name,
    desc: s.reason || '', badges: [], entry: '', entryNote: '', source: s.source || '한국문화정보원 펫동반 문화시설',
    mx: nx(s.longitude), my: ny(s.latitude), popular: [],
    latitude: s.latitude, longitude: s.longitude, isMock: !!s.is_mock,
  } as Place & { latitude: number; longitude: number }));
}

// 여정 타임라인 카드 클릭 → 상세 팝업용 Place 매핑. 코스 정류장(L)·코리도어 경유지(S) 모두 포함(슬라이스 없이 전체).
function mapItinPlaces(course: RoutePlanResponse | null): Place[] {
  if (!course) return [];
  const mk = (
    s: { name: string; category: string; latitude: number; longitude: number; reason?: string; source?: string; is_mock?: boolean },
    key: string, day: string, gi: number,
  ): Place => ({
    key, name: s.name, cat: s.category, rating: '', price: '', hours: '', loc: s.category,
    day, time: '', icon: liveIcon(s.category), grad: GRADS[gi % GRADS.length], label: s.name,
    desc: s.reason || '', badges: [], entry: '', entryNote: '', source: s.source || '한국문화정보원 펫동반 문화시설',
    mx: 50, my: 50, popular: [],
    latitude: s.latitude, longitude: s.longitude, isMock: !!s.is_mock,
  } as Place & { latitude: number; longitude: number });
  const stops = (course.stops ?? []).map((s, i) => mk(s, 'L' + i, `${i + 1}번째 코스`, i));
  const stopovers = (course.stopovers ?? []).map((s, i) => mk(s, 'S' + i, '경유지', i));
  return [...stops, ...stopovers];
}

// 시내 코스 핀이 ~40m 이내로 겹치면 번호 핀이 포개져 안 보인다.
// 이미 찍은 핀과 너무 가까운 핀을 인덱스 기반 작은 원형으로 미세 분산(좌표 약 35~45m).
function declutterPins<T extends { lat: number; lng: number }>(pts: T[]): T[] {
  const MIN = 0.0004; // ≈ 40m. 이보다 가까우면 겹침으로 간주.
  const placed: { lat: number; lng: number }[] = [];
  return pts.map((p) => {
    let { lat, lng } = p;
    let dup = 0;
    while (placed.some((q) => Math.abs(q.lat - lat) < MIN && Math.abs(q.lng - lng) < MIN)) {
      dup += 1;
      const ang = dup * 2.39996; // 황금각 → 겹친 핀들이 골고루 퍼짐
      lat = p.lat + Math.sin(ang) * MIN * (1 + dup * 0.15);
      lng = p.lng + Math.cos(ang) * MIN * (1 + dup * 0.15);
    }
    placed.push({ lat, lng });
    return { ...p, lat, lng };
  });
}

// 두 좌표 간 거리(km) — 직접 추가/제외 후 이전 정류장 거리 재계산용.
function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLa = toRad(b.latitude - a.latitude), dLo = toRad(b.longitude - a.longitude);
  const s = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// 백엔드 _stop_reason 미러 — 둘러보기에서 직접 추가한 곳의 추천 이유(업종·체리 특징).
function localStopReason(category: string): string {
  const c = category || '';
  if (/박물관|미술관|전시|유산원|문화원|과학관/.test(c)) return '실내 전시가 있어 더위에 약한 체리가 시원하게 둘러보기 좋아요(야외 마당 동반, 실내 전시관은 제한).';
  if (/공원|호수|정원|수목|산책|둘레|천|강/.test(c)) return '평지 야외라 대형견 체리가 목줄 산책하기 좋아요. 그늘·급수를 확인하세요.';
  if (/문예회관|공연|극장|전당|회관/.test(c)) return '야외 행사·마당은 동반 가능하고 실내 공연장은 제한돼요.';
  if (/카페|식당|맛집|음식/.test(c)) return '동반석이 있어 체리와 함께 쉬어가기 좋아요(테라스·목줄 확인).';
  if (/여행지|관광|명소|유적|사적/.test(c)) return '야외 명소라 대형견 체리와 목줄 산책으로 둘러보기 좋아요.';
  return '반려동물 동반 가능으로 등록된 곳이라 체리와 함께 입장할 수 있어요.';
}

// 실데이터 코스에 사용자 편집(제외 이름·추가 장소·숙소 교체)을 얹어 유효 코스를 만든다. 순서·이전거리 재계산.
function withCourseEdits(
  course: RoutePlanResponse | null, removed: string[], added: CourseAddStop[],
  lodgingSwaps: Record<string, LodgingPlace> = {},
): RoutePlanResponse | null {
  if (!course) return course;
  const kept = course.stops.filter((s) => !removed.includes(s.name));
  const extra = added
    .filter((p) => !removed.includes(p.name) && !kept.some((s) => s.name === p.name))
    .map((p) => ({
      order: 0, name: p.name, category: p.category, latitude: p.latitude, longitude: p.longitude,
      distance_from_prev_km: 0, similarity: 0, reason: localStopReason(p.category),
      source: '한국문화정보원 펫동반 문화시설',
      // 슬롯 메타 보존 — 스왑 교체 정류장이 여정 타임라인의 원래 자리(예: 오후 카페)에 들어가도록.
      day: p.day ?? 1, time_slot: (p.time_slot ?? 'morning') as RouteStop['time_slot'], clock: p.clock ?? '', is_meal: p.is_meal ?? false,
    }));
  const merged = [...kept, ...extra];
  const stops = merged.map((s, i) => ({ ...s, order: i + 1, distance_from_prev_km: i === 0 ? 0 : Math.round(haversineKm(merged[i - 1], s) * 100) / 100 }));
  // 숙소 교체 오버라이드 — 기존 숙소명 자리에 새 숙소를 끼운다(여정 취침 노드·지도 도착핀 반영).
  const lodging = (course.lodging ?? []).map((l) => lodgingSwaps[l.name] ?? l);
  return { ...course, stops, stop_count: stops.length, lodging };
}

const PAW = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="var(--accent)">
    <ellipse cx="12" cy="16" rx="5.5" ry="4.5" />
    <ellipse cx="5.3" cy="10" rx="2.3" ry="2.9" />
    <ellipse cx="9.9" cy="6.4" rx="2.3" ry="2.9" />
    <ellipse cx="14.1" cy="6.4" rx="2.3" ry="2.9" />
    <ellipse cx="18.7" cy="10" rx="2.3" ry="2.9" />
  </svg>
);

const LIGHT: Record<string, string> = { bg: '#E9EBEF', panel: '#FFFFFF', 'panel-2': '#F6F7F9', border: '#EAECEF', line: '#F0F1F4', text: '#181A1F', muted: '#8A8F98', faint: '#B5B9C0', accent: '#3B5BFE', 'accent-2': '#5B78FF', 'accent-soft': '#EEF1FF', chip: '#F3F4F6', hover: '#F2F3F5', map: '#E4E7EC', 'map-road': '#D2D6DD', 'user-text': '#FFFFFF', 'ai-bubble': '#F2F3F6', shadow: '0 8px 30px rgba(20,22,40,.08)' };
const DARK: Record<string, string> = { bg: '#08080A', panel: '#101014', 'panel-2': '#17171B', border: '#26262B', line: '#1F1F24', text: '#F1F2F5', muted: '#888B93', faint: '#5A5C63', accent: '#3B82F6', 'accent-2': '#5B9BFF', 'accent-soft': '#15233F', chip: '#1B1B20', hover: '#1E1E24', map: '#0C0C0F', 'map-road': '#1C1D22', 'user-text': '#FFFFFF', 'ai-bubble': '#1A1A1F', shadow: '0 8px 30px rgba(0,0,0,.4)' };

export default function App() {
  const app = usePlannerApp();
  const { dark, isMobile, mobilePanel, setMobilePanel, view, go, focusPlace, setFocus, input, setInput, listening, messages, suggestions, emg, setEmg, emgStep, setEmgStep, handleUserText, startVoice, resetChat, setDark, liveCourse, livePlan, liveLoading, voiceEnabled, toggleVoice, courseRemoved, courseAdded, lodgingSwaps, addCourseStop, removeCourseStop, pushAi } = app;

  // 전역 채팅 바(플래너 외 탭)에서 보여줄 최근 AI 응답 한 줄.
  const lastAiMsg = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'ai') return messages[i].text;
    return '';
  }, [messages]);

  // 실데이터 코스 + 사용자 편집(둘러보기/여정 추가·제외) = 유효 코스. 이후 지도/패널/여정이 공유.
  const effectiveCourse = useMemo(() => withCourseEdits(liveCourse, courseRemoved, courseAdded, lodgingSwaps), [liveCourse, courseRemoved, courseAdded, lodgingSwaps]);
  // 백엔드 course → Place 형태 매핑(지도/패널 공용, lat/lng 정규화)
  const items = useMemo(() => mapCourse(effectiveCourse), [effectiveCourse]);

  // 여정 타임라인 카드 클릭 → 상세 팝업(코스 정류장·경유지 공통). 플래너 전환 없이 여정 위 오버레이로 표시.
  const itinPlaces = useMemo(() => mapItinPlaces(effectiveCourse), [effectiveCourse]);
  const [itinKey, setItinKey] = useState<string | null>(null);
  const itinPlace = itinKey ? itinPlaces.find((p) => p.key === itinKey) ?? null : null;
  const [itinReviews, setItinReviews] = useState<Review[]>([]);
  useEffect(() => {
    if (!itinPlace) { setItinReviews([]); return; }
    let live = true;
    getReviews({ placeName: itinPlace.name }).then((r) => live && setItinReviews(r)).catch(() => live && setItinReviews([]));
    return () => { live = false; };
  }, [itinPlace?.name]);
  // 여정 탭을 벗어나면 팝업을 닫는다(재진입 시 자동 재오픈 방지).
  useEffect(() => { if (view !== 'itinerary') setItinKey(null); }, [view]);

  const c = items.find((p) => p.key === focusPlace) ?? items[0] ?? FALLBACK_PLACE;
  const tCode = ({ ktx: 'KTX', bus: 'BUS', car: 'CAR', unset: null } as const)[livePlan?.transport ?? 'unset'];
  const courseCount = effectiveCourse?.stop_count ?? items.length;
  const ready = livePlan?.stage === 'ready';
  // 목적지(코스 후=region, 코스 전=대화 중 destination). 지도·핀상세·스왑이 이 값을 따라간다.
  const region = effectiveCourse?.region ?? livePlan?.destination ?? '전주';
  const isJeonju = region === '전주';

  // 지도 2단계: (1) 여정 개요 = 서울 출발 → 경유지 → 전주 도착(단일 핀, 깔끔한 광역),
  // (2) 도착 핀 클릭 시 로컬 = 전주 코스 정류장(번호 핀). 전국 줌에서 핀이 뭉치는 걸 방지.
  const [localMap, setLocalMap] = useState(false);
  useEffect(() => { setLocalMap(false); }, [courseCount]); // 코스 바뀌면 개요로 복귀

  // 목적지 도심 좌표 — 도시 펫시설 센트로이드(실데이터). 목적지가 바뀌면 1회 조회·캐시 → 전주 외 도시도 지도가 따라간다.
  const [destAnchor, setDestAnchor] = useState<{ lat: number; lng: number } | null>(null);
  const anchorCache = useRef<Record<string, { lat: number; lng: number }>>({});
  useEffect(() => {
    const d = livePlan?.destination;
    if (!d) { setDestAnchor(null); return; }
    const hit = anchorCache.current[d];
    if (hit) { setDestAnchor(hit); return; }
    let on = true;
    searchPlaces(d).then((places) => {
      if (!on || !places.length) return;
      const anc = {
        lat: places.reduce((a, p) => a + p.latitude, 0) / places.length,
        lng: places.reduce((a, p) => a + p.longitude, 0) / places.length,
      };
      anchorCache.current[d] = anc;
      setDestAnchor(anc);
    }).catch(() => {});
    return () => { on = false; };
  }, [livePlan?.destination]);

  const journeyPoints = useMemo(() => {
    // 로컬: 도착 지점(전주 KTX 전주역 / 고속터미널)에서 시작 → 코스 정류장(번호 핀).
    // 실제로 내리는 곳에서부터 동선이 이어지도록 도착 앵커를 맨 앞에 둔다(자차·전주 외 도시는 역 좌표가 없어 코스만).
    if (localMap) {
      const arr = (tCode === 'CAR' || !isJeonju) ? [] : journeyTransit(tCode).map((t) => ({
        lat: t.lat, lng: t.lng, name: t.name, role: 'transit' as const, caption: `${t.name} 도착`, icon: t.icon,
      }));
      const stops = declutterPins(items.map((it, i) => ({ lat: it.latitude, lng: it.longitude, name: it.name, category: it.cat, order: i + 1 })));
      return [...arr, ...stops];
    }
    // 여정 개요 — 교통수단별 출발(역/터미널/내위치)→이동(경유지 or 도착역)→목적지 도착.
    // 아직 코스가 없으면(대화 중) livePlan으로 서울→목적지 매크로 경로를 점진적으로 그린다.
    if (!items.length) {
      if (!livePlan?.destination) return [];
      const dest = destAnchor ?? JEONJU_ANCHOR;
      const destPin = { lat: dest.lat, lng: dest.lng, name: livePlan.destination, role: 'dest' as const, caption: `${livePlan.destination} 도착` };
      // 전주 외 도시: 역·코리도어 좌표 미보유 → 서울(내 위치)→목적지 광역 직결.
      if (!isJeonju) return [journeyOrigin(null), destPin];
      // 전주: 목적지만 정해짐 → 서울→전주 직선(미정), 이동수단 정해짐 → 도착역/터미널 추가.
      return [journeyOrigin(tCode), ...journeyTransit(tCode), destPin];
    }
    // 숙박이면 대표 숙소(lodging[0])를 도착 핀으로 → 지도가 서울→(경유지)→숙소로 그려진다.
    // 당일치기 등 숙소가 없으면 코스 중심 좌표로 폴백.
    const lodge = effectiveCourse?.lodging?.[0];
    const cLat = lodge?.latitude ?? items.reduce((a, p) => a + p.latitude, 0) / items.length;
    const cLng = lodge?.longitude ?? items.reduce((a, p) => a + p.longitude, 0) / items.length;
    const destCaption = lodge ? `${lodge.name} 체크인` : `${region} 도착 · ${courseCount}곳`;
    const destPin = { lat: cLat, lng: cLng, name: lodge?.name ?? region, role: 'dest' as const, caption: destCaption };
    // 전주 외 도시: 경유지·역 좌표 미보유 → 서울(내 위치)→숙소 광역 직결.
    if (!isJeonju) return [journeyOrigin(null), destPin];
    // 자차 = 코리도어 경유지(실데이터), KTX/버스 = 도착역/터미널, 그 외 = 없음.
    const mid = tCode === 'CAR'
      ? (effectiveCourse?.stopovers ?? []).map((s) => ({ lat: s.latitude, lng: s.longitude, name: s.name, role: 'stopover' as const, caption: s.name }))
      : journeyTransit(tCode);
    return [journeyOrigin(tCode), ...mid, destPin];
  }, [localMap, effectiveCourse, items, courseCount, tCode, livePlan, destAnchor, isJeonju, region]);

  // 실 경로선 — 어떤 구간이든 "땅으로 이동"하는 모습이 되도록 직선 대각선(=비행 느낌)을 없앤다.
  //  · 시내 코스 드릴다운: OSRM 도로 라우팅(실제 도로를 따라 정류장 연결).
  //  · 서울→전주 자차/버스 광역: OSRM 도로 라우팅(고속도로/국도).
  //  · 서울→전주 KTX: 철도라 도로 라우팅 대상이 아니므로 실제 정차역 코리도어로 경로를 그린다.
  // 실패 시 직선 폴백.
  const [routePath, setRoutePath] = useState<{ lat: number; lng: number }[] | null>(null);
  useEffect(() => {
    const pts = journeyPoints.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)).map((p) => ({ lat: p.lat, lng: p.lng }));
    if (pts.length < 2) { setRoutePath(null); return; }
    // 광역 KTX 구간(전주 한정) → 실제 정차역 코리도어(철도 근사). 도로 라우팅 호출 안 함.
    // 전주 외 도시 KTX는 코리도어 좌표가 없어 직선 연결(NaverMap)로 광역 이동 표시.
    if (!localMap && isJeonju && tCode === 'KTX') { setRoutePath(KTX_CORRIDOR); return; }
    // 시내 코스 + 자차/버스 광역 → OSRM 도로 라우팅.
    const usesRoad = localMap || tCode === 'CAR' || tCode === 'BUS';
    if (!usesRoad) { setRoutePath(null); return; }
    let on = true;
    setRoutePath(null);
    fetchDrivingRoute(pts).then((r) => on && setRoutePath(r)).catch(() => on && setRoutePath(null));
    return () => { on = false; };
  }, [JSON.stringify(journeyPoints), tCode, localMap, isJeonju]);

  // 시설 후기 — 실데이터(/map/review, 장소명 매칭)
  const [reviews, setReviews] = useState<Review[]>([]);
  useEffect(() => {
    let live = true;
    getReviews({ placeName: c.name })
      .then((r) => live && setReviews(r))
      .catch(() => live && setReviews([]));
    return () => {
      live = false;
    };
  }, [c.name]);

  // 테마 + 반응형 CSS 변수 → 루트 인라인 스타일
  const palette = dark ? DARK : LIGHT;
  const vars: Record<string, string> = {};
  Object.keys(palette).forEach((k) => (vars['--' + k] = palette[k]));
  const pd = (n: string) => (isMobile ? (mobilePanel === n ? 'flex' : 'none') : 'flex');
  vars['--body-dir'] = isMobile ? 'column' : 'row';
  ['chat', 'detail', 'map'].forEach((n) => {
    vars['--' + n + '-flex'] = isMobile ? '1 1 auto' : '1 1 0';
    vars['--' + n + '-w'] = isMobile ? '100%' : '0';
    vars['--' + n + '-d'] = pd(n);
  });
  vars['--mobnav-d'] = isMobile && view === 'planner' ? 'flex' : 'none';
  vars['--fab-lift'] = isMobile && view === 'planner' ? '60px' : '0px';

  const rootStyle: CSSProperties = { position: 'relative', width: '100vw', flex: '1 1 0', minHeight: 0, background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Pretendard,-apple-system,sans-serif', color: 'var(--text)', transition: 'background .25s', ...(vars as CSSProperties) };

  const navItem = (v: typeof view, label: string, icon?: string) => {
    const on = view === v;
    return (
      <div onClick={() => go(v)} style={css(`display:flex; align-items:center; gap:6px; font:${on ? 700 : 600} 13.5px Pretendard; padding:8px 14px; border-radius:10px; cursor:pointer; white-space:nowrap; background:${on ? 'var(--accent-soft)' : 'transparent'}; color:${on ? 'var(--accent)' : 'var(--muted)'};`)}>
        {icon && <span className="msf" style={css('font-size:16px;')}>{icon}</span>}
        {label}
      </div>
    );
  };

  return (
    <div style={rootStyle}>
      <div style={css('width:min(1480px,96vw); height:min(948px,95vh); background:var(--panel); border:1px solid var(--border); border-radius:22px; overflow:hidden; display:flex; flex-direction:column; box-shadow:var(--shadow);')}>
        {/* TOP NAV */}
        <div style={css('display:flex; align-items:center; gap:16px; padding:0 20px; height:60px; flex:none; border-bottom:1px solid var(--border);')}>
          <div style={css('display:flex; align-items:center; gap:9px;')}>
            <div style={css('width:32px; height:32px; border-radius:10px; background:var(--accent); display:flex; align-items:center; justify-content:center;')}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="#fff">
                <ellipse cx="12" cy="16" rx="5.5" ry="4.5" /><ellipse cx="5.3" cy="10" rx="2.3" ry="2.9" /><ellipse cx="9.9" cy="6.4" rx="2.3" ry="2.9" /><ellipse cx="14.1" cy="6.4" rx="2.3" ry="2.9" /><ellipse cx="18.7" cy="10" rx="2.3" ry="2.9" />
              </svg>
            </div>
            <span style={css('font:800 18px Pretendard; letter-spacing:-0.03em;')}>발자국</span>
          </div>
          <div className="sc" style={css('display:flex; align-items:center; gap:3px; margin-left:10px; overflow-x:auto;')}>
            {navItem('planner', 'AI 플래너', 'auto_awesome')}
            {navItem('explore', '둘러보기')}
            {navItem('itinerary', '여정')}
            {navItem('dog', '내 강아지')}
          </div>
          <div style={css('margin-left:auto; display:flex; align-items:center; gap:8px;')}>
            <div onClick={toggleVoice} title={voiceEnabled ? '음성 안내 끄기' : '음성 안내 켜기'} style={css(`width:38px; height:38px; border-radius:11px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:${voiceEnabled ? 'var(--accent)' : 'var(--muted)'}; background:${voiceEnabled ? 'var(--accent-soft)' : 'var(--chip)'};`)}>
              <span className="msr" style={css('font-size:20px;')}>{voiceEnabled ? 'volume_up' : 'volume_off'}</span>
            </div>
            <div onClick={() => setDark(!dark)} title="테마" style={css('width:38px; height:38px; border-radius:11px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--muted); background:var(--chip);')}>
              <span className="msr" style={css('font-size:20px;')}>{dark ? 'light_mode' : 'dark_mode'}</span>
            </div>
            <div style={css('width:38px; height:38px; border-radius:11px; display:flex; align-items:center; justify-content:center; color:var(--muted); background:var(--chip); position:relative;')}>
              <span className="msr" style={css('font-size:20px;')}>notifications</span>
              <span style={css('position:absolute; top:9px; right:10px; width:7px; height:7px; border-radius:50%; background:#FF6B5C; border:2px solid var(--panel);')} />
            </div>
            <div style={css('display:flex; align-items:center; gap:9px; padding:5px 12px 5px 6px; border-radius:999px; background:var(--chip);')}>
              <div style={css('width:30px; height:30px; border-radius:50%; background:linear-gradient(135deg,#9CC2FF,#3B5BFE); display:flex; align-items:center; justify-content:center; font:800 12px Pretendard; color:#fff;')}>민</div>
              <div style={css('line-height:1.15;')}>
                <div style={css('font:700 12.5px Pretendard;')}>김민주</div>
                <div style={css('font:500 11px Pretendard; color:var(--muted);')}>@minju</div>
              </div>
            </div>
          </div>
        </div>

        {/* BODY */}
        <div style={css('flex:1; min-height:0; display:flex; position:relative;')}>
          {view === 'planner' && (
            <div style={css('flex:1; min-width:0; display:flex; flex-direction:var(--body-dir);')}>
              {/* LEFT · CHAT */}
              <div style={css('display:var(--chat-d); flex:var(--chat-flex); width:var(--chat-w); min-width:0; flex-direction:column; border-right:1px solid var(--border); background:var(--panel);')}>
                <div style={css('display:flex; align-items:center; gap:10px; padding:14px 18px 10px; flex:none;')}>
                  <div style={css('display:flex; align-items:center; gap:7px; font:700 14px Pretendard;')}>
                    <span className="msf" style={css('font-size:17px; color:var(--accent);')}>auto_awesome</span>발자국AI 1.0
                  </div>
                  <div style={css('margin-left:auto; display:flex; align-items:center; gap:6px;')}>
                    {/* 실데이터 뱃지(공공데이터 기반 — 비클릭) */}
                    <div title="전주 펫 동반 공공데이터" style={css('display:flex; align-items:center; gap:5px; font:700 11px Pretendard; padding:6px 10px; border-radius:999px; background:var(--accent-soft); color:var(--accent);')}>
                      <span className="msf" style={css('font-size:13px;')}>satellite_alt</span>실데이터
                    </div>
                    <div onClick={resetChat} title="새 대화" style={css('width:32px; height:32px; border-radius:9px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--muted);')}>
                      <span className="msr" style={css('font-size:19px;')}>add</span>
                    </div>
                  </div>
                </div>
                <div className="sc" id="plannerConv" style={css('flex:1; min-height:0; overflow-y:auto; padding:8px 18px 4px; display:flex; flex-direction:column; gap:14px;')}>
                  {messages.map((m, i) =>
                    m.role === 'user' ? (
                      <div key={i} style={css('align-self:flex-end; max-width:84%; background:var(--accent); color:var(--user-text); font:500 14px Pretendard; line-height:1.55; padding:11px 15px; border-radius:16px 16px 5px 16px;')}>{m.text}</div>
                    ) : (
                      <div key={i}>
                        <div style={css('display:flex; gap:9px; align-items:flex-start; max-width:94%;')}>
                          <div style={css('width:26px; height:26px; border-radius:8px; background:var(--accent-soft); flex:none; display:flex; align-items:center; justify-content:center; margin-top:1px;')}>{PAW}</div>
                          <div style={css('font:500 14px Pretendard; line-height:1.62; color:var(--text); padding-top:2px;')}>{m.text}</div>
                        </div>
                        {m.doc && (
                          <div onClick={() => go('itinerary')} style={css('margin-left:35px; margin-top:8px; display:inline-flex; align-items:center; gap:10px; background:var(--panel-2); border:1px solid var(--border); border-radius:13px; padding:11px 14px; cursor:pointer; max-width:88%;')}>
                            <div style={css('width:34px; height:34px; border-radius:9px; background:var(--accent); display:flex; align-items:center; justify-content:center; flex:none;')}>
                              <span className="msf" style={css('font-size:18px; color:#fff;')}>map</span>
                            </div>
                            <div style={css('min-width:0;')}>
                              <div style={css('font:700 13px Pretendard;')}>{`${effectiveCourse?.region ?? '전주'} 펫 동반 코스`}</div>
                              <div style={css('font:500 11px Pretendard; color:var(--muted); margin-top:1px;')}>{courseCount}곳 · 입장 가능 · 출처 확인됨</div>
                            </div>
                            <span className="msr" style={css('font-size:18px; color:var(--muted); margin-left:4px;')}>chevron_right</span>
                          </div>
                        )}
                      </div>
                    ),
                  )}
                  {(listening || liveLoading) && (
                    <div style={css('display:flex; gap:9px; align-items:center;')}>
                      <div style={css(`width:26px; height:26px; border-radius:8px; background:${listening ? '#FF6B5C' : 'var(--accent-soft)'}; flex:none; display:flex; align-items:center; justify-content:center;`)}>
                        <span className="msf" style={css(`font-size:14px; color:${listening ? '#fff' : 'var(--accent)'};`)}>{listening ? 'mic' : 'auto_awesome'}</span>
                      </div>
                      <div style={css('display:flex; align-items:center; gap:3px; height:22px;')}>
                        {[0, 0.15, 0.3, 0.45].map((d) => (
                          <span key={d} style={{ width: 3, height: 16, background: 'var(--accent)', borderRadius: 2, animation: `wv 1s ease-in-out ${d}s infinite` }} />
                        ))}
                        <span style={css('font:600 11px Pretendard; color:var(--muted); margin-left:7px;')}>{listening ? '듣는 중…' : '코스를 그리는 중…'}</span>
                      </div>
                    </div>
                  )}
                </div>
                {suggestions.length > 0 && !listening && !liveLoading && (
                  <div className="sc" style={css('flex:none; display:flex; gap:7px; padding:8px 18px; overflow-x:auto;')}>
                    {suggestions.map((sug) => (
                      <div key={sug} onClick={() => (sug === '여정 보기' ? go('itinerary') : handleUserText(sug))} style={css('flex:none; font:600 12.5px Pretendard; color:var(--accent); background:var(--accent-soft); padding:8px 13px; border-radius:999px; cursor:pointer; white-space:nowrap;')}>{sug}</div>
                    ))}
                  </div>
                )}
                <div style={css('flex:none; padding:6px 18px 16px;')}>
                  <div style={css('display:flex; align-items:center; gap:9px; background:var(--panel-2); border:1px solid var(--border); border-radius:16px; padding:7px 7px 7px 16px;')}>
                    <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { const v = input.trim(); if (v) handleUserText(v); } }} placeholder="무엇이든 물어보세요…" style={css('flex:1; min-width:0; background:transparent; border:none; outline:none; font:500 14px Pretendard; color:var(--text);')} />
                    <div onClick={startVoice} style={css(`width:36px; height:36px; border-radius:11px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:${listening ? '#fff' : 'var(--muted)'}; background:${listening ? '#FF6B5C' : 'var(--chip)'};`)}>
                      <span className="msf" style={css('font-size:19px;')}>mic</span>
                    </div>
                    <div onClick={() => { const v = input.trim(); if (v) handleUserText(v); }} style={css('width:36px; height:36px; border-radius:11px; background:var(--accent); color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer;')}>
                      <span className="msf" style={css('font-size:19px;')}>arrow_upward</span>
                    </div>
                  </div>
                  <div style={css('font:400 10.5px Pretendard; color:var(--faint); text-align:center; margin-top:8px;')}>발자국AI는 참고용이며 안전·규정은 규칙으로 확인해요 · 음성은 저장하지 않아요</div>
                </div>
              </div>

              {/* CENTER · DETAIL */}
              <div className="sc" style={css('display:var(--detail-d); flex:var(--detail-flex); width:var(--detail-w); min-width:0; flex-direction:column; overflow-y:auto; background:var(--panel-2); border-right:1px solid var(--border);')}>
                  <LiveDetail stop={c} region={region} hasCourse={items.length > 0} inCourse={!!effectiveCourse?.stops.some((s) => s.name === c.name)} reviews={reviews} onAdd={() => {
                    const cc = c as Place & { latitude: number; longitude: number };
                    if (effectiveCourse?.stops.some((s) => s.name === cc.name)) { removeCourseStop(cc.name); pushAi(`${cc.name}을(를) 코스에서 뺐어요.`); }
                    else { addCourseStop({ name: cc.name, category: cc.cat, latitude: cc.latitude, longitude: cc.longitude }); pushAi(`${cc.name}을(를) 코스에 담았어요.`); }
                  }} onClose={() => isMobile && setMobilePanel('chat')} onItin={() => go('itinerary')} />
              </div>

              {/* RIGHT · MAP — 실 네이버 지도(키 도메인 제한/로드 실패 시 아래 SVG로 폴백) */}
              <div style={css('display:var(--map-d); flex:var(--map-flex); width:var(--map-w); min-width:0; position:relative; background:var(--map); overflow:hidden;')}>
                {localMap && (
                  <div onClick={() => setLocalMap(false)} style={css('position:absolute; left:14px; top:14px; z-index:3; display:flex; align-items:center; gap:5px; background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:8px 12px; cursor:pointer; box-shadow:var(--shadow); font:700 12px Pretendard;')}>
                    <span className="msr" style={css('font-size:17px; color:var(--accent);')}>arrow_back</span>여정으로 · {region} {items.length}곳
                  </div>
                )}
                <NaverMap
                  flush
                  path
                  routePath={routePath ?? undefined}
                  label={localMap ? '' : `서울 → ${region} · ${transportLabel(tCode)}${courseCount ? ` · 실데이터 ${courseCount}곳` : ' · 경로 구성 중'}`}
                  points={journeyPoints}
                  onSelect={(pt) => { if ((pt as any).role === 'dest') { setLocalMap(true); return; } const hit = items.find((x) => x.name === pt.name); if (hit) setFocus(hit.key); }}
                  fallback={
                    <>
                      <svg viewBox="0 0 400 700" preserveAspectRatio="xMidYMid slice" style={css('position:absolute; inset:0; width:100%; height:100%;')}>
                        <path d="M-20 140 H420 M-20 360 H420 M-20 540 H420 M90 -20 V720 M250 -20 V720 M340 -20 V720" stroke="var(--map-road)" strokeWidth="10" fill="none" />
                        <path d="M-20 250 C 120 280, 200 420, 420 460" stroke="var(--map-road)" strokeWidth="14" fill="none" opacity=".7" />
                        <path d="M40 60 L 360 640" stroke="var(--map-road)" strokeWidth="3" strokeDasharray="2 10" fill="none" />
                      </svg>
                      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={css('position:absolute; inset:0; width:100%; height:100%;')}>
                        <polyline points={items.map((it) => it.mx + ',' + it.my).join(' ')} fill="none" stroke="var(--accent)" strokeWidth=".6" strokeLinecap="round" strokeDasharray="1 2.4" opacity=".85" />
                      </svg>
                      {items.map((it) => {
                        const focused = it.key === focusPlace;
                        return (
                          <div key={it.key} onClick={() => setFocus(it.key)} style={css(`position:absolute; left:${it.mx}%; top:${it.my}%; transform:translate(-50%,-100%); cursor:pointer; z-index:${focused ? 5 : 2};`)}>
                            {focused ? (
                              <div style={css('position:relative; width:54px; height:54px; border-radius:50% 50% 50% 6px; background:var(--accent); display:flex; align-items:center; justify-content:center; box-shadow:0 8px 20px rgba(59,91,254,.45); border:3px solid var(--panel);')}>
                                <span className="msf" style={css('font-size:24px; color:#fff;')}>{it.icon}</span>
                                <span style={{ position: 'absolute', inset: -6, borderRadius: '50%', border: '2px solid var(--accent)', animation: 'ping 1.8s ease-out infinite' }} />
                              </div>
                            ) : (
                              <div style={css('width:34px; height:34px; border-radius:50% 50% 50% 4px; background:var(--panel); display:flex; align-items:center; justify-content:center; box-shadow:0 4px 12px rgba(20,22,40,.18); border:1px solid var(--border);')}>
                                <span className="msf" style={css('font-size:17px; color:var(--accent);')}>{it.icon}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      <div style={css('position:absolute; left:14px; top:14px; display:flex; align-items:center; gap:7px; background:var(--panel); border:1px solid var(--border); border-radius:11px; padding:9px 13px; box-shadow:var(--shadow);')}>
                        <span className="msf" style={css('font-size:17px; color:var(--accent);')}>route</span>
                        <div style={css('line-height:1.2;')}>
                          <div style={css('font:700 12px Pretendard;')}>서울 → {region} · {transportLabel(tCode)}</div>
                          <div style={css('font:500 10.5px Pretendard; color:var(--muted);')}>{`실데이터 ${courseCount}곳`}</div>
                        </div>
                      </div>
                      {items.length === 0 && (
                        <div style={css('position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font:600 13px Pretendard; color:var(--muted); text-align:center; padding:0 30px;')}>채팅에서 "전주로 갈거야"라고 말하면 실데이터 코스가 그려져요</div>
                      )}
                      <div style={css('position:absolute; left:14px; bottom:14px; font:600 10px ui-monospace,monospace; color:var(--muted); background:var(--panel); padding:5px 9px; border-radius:7px; border:1px solid var(--border);')}>GPS 아님 · 좌표 보간 경로</div>
                    </>
                  }
                />
              </div>
            </div>
          )}

          {view === 'explore' && <Explore onText={handleUserText} hasCourse={!!effectiveCourse} courseNames={effectiveCourse?.stops.map((s) => s.name) ?? []} days={Math.max(1, (livePlan?.nights ?? 0) + 1, ...(effectiveCourse?.stops.map((s) => s.day ?? 1) ?? [1]))} onAdd={addCourseStop} onRemove={removeCourseStop} />}
          {view === 'itinerary' && (
            <>
              <Itinerary liveCourse={effectiveCourse} region={region} anchor={isJeonju ? null : destAnchor} tCode={tCode} nights={livePlan?.nights ?? 0} transport={transportLabel(tCode)} ready={ready} onStop={(k) => setItinKey(k)} onEmergency={() => { setEmg(true); setEmgStep('entry'); }} onRemove={removeCourseStop} />
              {itinPlace && (
                <div onClick={() => setItinKey(null)} style={css(`position:fixed; inset:0; z-index:120; background:rgba(15,18,40,.45); display:flex; align-items:${isMobile ? 'stretch' : 'center'}; justify-content:center; ${isMobile ? '' : 'padding:24px;'}`)}>
                  <div className="sc" onClick={(e) => e.stopPropagation()} style={css(`display:flex; flex-direction:column; overflow-y:auto; background:var(--panel-2); box-shadow:var(--shadow); ${isMobile ? 'width:100%; height:100%;' : 'width:min(440px,94vw); max-height:90vh; border-radius:22px;'}`)}>
                    <LiveDetail
                      stop={itinPlace} region={region} hasCourse={itinPlaces.length > 0}
                      inCourse={!!effectiveCourse?.stops.some((s) => s.name === itinPlace.name)}
                      reviews={itinReviews}
                      onAdd={() => {
                        const cc = itinPlace as Place & { latitude: number; longitude: number };
                        if (effectiveCourse?.stops.some((s) => s.name === cc.name)) { removeCourseStop(cc.name); pushAi(`${cc.name}을(를) 코스에서 뺐어요.`); }
                        else { addCourseStop({ name: cc.name, category: cc.cat, latitude: cc.latitude, longitude: cc.longitude }); pushAi(`${cc.name}을(를) 코스에 담았어요.`); }
                        setItinKey(null);
                      }}
                      onClose={() => setItinKey(null)} onItin={() => setItinKey(null)}
                    />
                  </div>
                </div>
              )}
            </>
          )}
          {view === 'dog' && <Dog />}

          {/* GLOBAL CHAT BAR — 플래너 외 모든 탭(둘러보기·여정·내 강아지) 중앙 하단에서 AI와 계속 대화 */}
          {view !== 'planner' && (
            <div style={css('position:absolute; left:0; right:0; bottom:0; display:flex; justify-content:center; padding:0 20px 20px; pointer-events:none; z-index:35;')}>
              <div style={css('width:min(660px,100%); pointer-events:auto;')}>
                {lastAiMsg && (
                  <div style={css('margin:0 auto 10px; background:var(--panel); border:1px solid var(--border); border-radius:15px; padding:11px 14px; box-shadow:0 8px 26px rgba(20,22,40,.16); display:flex; gap:9px; align-items:flex-start;')}>
                    <span className="msf" style={css('font-size:17px; color:var(--accent); flex:none; margin-top:1px;')}>auto_awesome</span>
                    <div style={{ ...css('font:500 12.5px Pretendard; color:var(--text); line-height:1.55;'), display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{lastAiMsg}</div>
                  </div>
                )}
                <div style={css('display:flex; align-items:center; gap:9px; background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:7px 7px 7px 16px; box-shadow:0 12px 32px rgba(20,22,40,.2);')}>
                  <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { const v = input.trim(); if (v) handleUserText(v); } }} placeholder="AI와 대화하며 코스를 편집해요…" style={css('flex:1; min-width:0; background:transparent; border:none; outline:none; font:500 14px Pretendard; color:var(--text);')} />
                  <div onClick={startVoice} style={css(`width:36px; height:36px; border-radius:11px; display:flex; align-items:center; justify-content:center; cursor:pointer; color:${listening ? '#fff' : 'var(--muted)'}; background:${listening ? '#FF6B5C' : 'var(--chip)'};`)}>
                    <span className="msf" style={css('font-size:19px;')}>mic</span>
                  </div>
                  <div onClick={() => { const v = input.trim(); if (v) handleUserText(v); }} style={css('width:36px; height:36px; border-radius:11px; background:var(--accent); color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer;')}>
                    <span className="msf" style={css('font-size:19px;')}>arrow_upward</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* MOBILE PANEL NAV (planner only) */}
          <div style={css('display:var(--mobnav-d); position:absolute; left:0; right:0; bottom:0; height:60px; background:var(--panel); border-top:1px solid var(--border); align-items:center; z-index:30;')}>
            {([['chat', 'forum', '채팅'], ['detail', 'description', '여정'], ['map', 'map', '지도']] as const).map(([p, icon, lab]) => (
              <div key={p} onClick={() => setMobilePanel(p)} style={css('flex:1; text-align:center; cursor:pointer;')}>
                <span className="msf" style={css(`font-size:22px; color:${mobilePanel === p ? 'var(--accent)' : 'var(--muted)'};`)}>{icon}</span>
                <div style={css(`font:600 10px Pretendard; color:${mobilePanel === p ? 'var(--accent)' : 'var(--muted)'}; margin-top:2px;`)}>{lab}</div>
              </div>
            ))}
          </div>

          {/* EMERGENCY FAB */}
          <div onClick={() => { setEmg(true); setEmgStep('entry'); }} style={css('position:absolute; right:22px; bottom:calc(22px + var(--fab-lift,0px)); width:54px; height:54px; border-radius:17px; background:#FF6B5C; box-shadow:0 10px 26px rgba(255,107,92,.45); display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:pointer; z-index:40;')}>
            <span className="msf" style={css('font-size:22px; color:#fff;')}>emergency</span>
            <span style={css('font:700 8px Pretendard; color:#fff; margin-top:1px;')}>응급</span>
          </div>

          {/* EMERGENCY MODAL */}
          {emg && <Emergency step={emgStep} setStep={setEmgStep} onClose={() => setEmg(false)} />}
        </div>
      </div>
    </div>
  );
}

// 여정 타임라인 노드 — 출발/이동(경유지·역)/도착/코스 정류장 공통 모델.
type JNode = {
  tone: 'origin' | 'transit' | 'stopover' | 'arrive' | 'day' | 'slot' | 'stop' | 'meal' | 'sleep';
  icon?: string; num?: number; time?: string;
  title: string; sub?: string; reason?: string; badges?: string[];
  similarity?: number; dist?: number; source?: string; onClick?: () => void; onRemove?: () => void;
  isMeal?: boolean; imageUrl?: string | null; phone?: string | null; address?: string | null;
  isMock?: boolean;
};
const RISK_TONE: Record<string, { c: string; bg: string; label: string }> = {
  high: { c: '#E0533F', bg: 'rgba(224,83,63,.12)', label: '위험' },
  moderate: { c: '#D98A00', bg: 'rgba(217,138,0,.12)', label: '주의' },
  low: { c: '#1B8A55', bg: 'rgba(34,165,101,.12)', label: '양호' },
};
const TONE_STYLE: Record<JNode['tone'], { bg: string; fg: string }> = {
  origin: { bg: '#1A1A1D', fg: '#fff' },
  transit: { bg: 'var(--accent-soft)', fg: 'var(--accent)' },
  stopover: { bg: 'rgba(34,165,101,.14)', fg: '#1B8A55' },
  arrive: { bg: 'var(--accent)', fg: '#fff' },
  day: { bg: 'var(--chip)', fg: 'var(--text)' },
  slot: { bg: 'var(--chip)', fg: 'var(--text)' },
  stop: { bg: 'var(--accent)', fg: '#fff' },
  meal: { bg: '#E8862B', fg: '#fff' },
  sleep: { bg: 'rgba(99,102,241,.16)', fg: '#6366F1' },
};
// 시간대 블록 — 아침/점심/오후/저녁 서브헤더 라벨·아이콘·순서.
const SLOT_ORDER = ['morning', 'lunch', 'afternoon', 'dinner'] as const;
const SLOT_META: Record<string, { label: string; icon: string }> = {
  morning: { label: '아침', icon: 'wb_twilight' },
  lunch: { label: '점심', icon: 'lunch_dining' },
  afternoon: { label: '오후', icon: 'wb_sunny' },
  dinner: { label: '저녁', icon: 'dinner_dining' },
};

// 내비형 여정 타임라인 — 서울 출발 → (경유지/도착역) → 전주 도착 → 코스 정류장.
// 각 노드에서 체리(대형견·더위 취약) 맞춤 정보를 실데이터로 노출. 백엔드 무변경.
function Itinerary({ liveCourse, region, anchor, tCode, nights, transport, ready, onStop, onEmergency, onRemove }: {
  liveCourse: RoutePlanResponse | null;
  region: string; anchor: { lat: number; lng: number } | null;
  tCode: TransportCode; nights: number; transport: string; ready: boolean;
  onStop: (k: string) => void; onEmergency: () => void; onRemove: (name: string) => void;
}) {
  const [safety, setSafety] = useState<SafetyAlertResult | null>(null);
  useEffect(() => {
    let on = true;
    checkSafety({ region, pet_breed: '골든 리트리버', pet_size: 'large', latitude: anchor?.lat ?? 35.8149, longitude: anchor?.lng ?? 127.153 })
      .then((s) => on && setSafety(s))
      .catch(() => {});
    return () => { on = false; };
  }, [region, anchor]);

  const origin = journeyOrigin(tCode);
  // 코스 정류장 — 백엔드 stops(닮은친구%·이유·이전 거리·일자·시간대).
  const stops = (liveCourse?.stops ?? []).map((s, i) => ({
    key: 'L' + i, name: s.name, time: `${i + 1}번째`, sub: s.category, reason: s.reason,
    similarity: s.similarity, dist: s.distance_from_prev_km, badges: [] as string[], source: s.source,
    day: s.day ?? 1, slot: s.time_slot ?? 'morning', clock: s.clock ?? '',
    isMeal: !!s.is_meal, imageUrl: s.image_url ?? null, phone: s.phone ?? null, address: s.address ?? null,
    isMock: !!s.is_mock,
  }));
  const count = stops.length;
  const hasMock = stops.some((s) => s.isMock);

  // 노드 조립: 출발 → 이동(경유지/도착역) → 도착 → 코스.
  const nodes: JNode[] = [];
  nodes.push({
    tone: 'origin', icon: origin.icon, title: origin.name, sub: `${transport} · 출발`,
    reason: '대형견 체리는 장거리 이동이 부담돼요. 2시간마다 휴식·급수, 차내 환기를 챙겨주세요.',
  });
  if (tCode === 'CAR') {
    // 코리도어 경유지 — 카드 클릭 시 상세 팝업(키 'S'+i, 부모 itinPlaces의 경유지 인덱스와 일치).
    (liveCourse?.stopovers ?? []).forEach((s, i) => nodes.push({
      tone: 'stopover', icon: 'pets', title: s.name, sub: s.category, reason: s.reason, badges: [],
      onClick: () => onStop('S' + i),
    }));
  } else {
    for (const t of journeyTransit(tCode)) nodes.push({ tone: 'transit', icon: t.icon || 'train', title: t.name, sub: `${transport} 이동 · 도착` });
  }
  const stayLabel = nights >= 1 ? `${nights}박 ${nights + 1}일` : '당일치기';
  nodes.push({ tone: 'arrive', icon: 'flag', title: `${region} 도착`, sub: `${stayLabel} · 코스 ${count}곳` });

  const pushStop = (s: typeof stops[number], n: number) => nodes.push({
    tone: s.isMeal ? 'meal' : 'stop', num: s.isMeal ? undefined : n, icon: s.isMeal ? 'restaurant' : undefined,
    time: s.time, title: s.name, sub: s.sub, reason: s.reason,
    badges: s.badges, similarity: s.similarity, dist: s.dist, source: s.source,
    isMeal: s.isMeal, imageUrl: s.imageUrl, phone: s.phone, address: s.address, isMock: s.isMock,
    onClick: () => onStop(s.key), onRemove: () => onRemove(s.name),
  });

  if (count > 0) {
    // 백엔드가 배정한 일자(day)·시간대(slot)로 Day → 아침/점심/오후/저녁 블록 그룹핑.
    const lodging = liveCourse?.lodging ?? [];
    const days = Array.from(new Set(stops.map((s) => s.day))).sort((a, b) => a - b);
    let num = 0;
    days.forEach((d) => {
      nodes.push({ tone: 'day', title: `Day ${d}`, sub: `${d}일차` });
      const dayStops = stops.filter((s) => s.day === d);
      SLOT_ORDER.forEach((slot) => {
        const slotStops = dayStops.filter((s) => s.slot === slot);
        if (!slotStops.length) return;
        const clock = slotStops.find((s) => s.clock)?.clock ?? '';
        nodes.push({ tone: 'slot', icon: SLOT_META[slot].icon, title: SLOT_META[slot].label, sub: clock });
        slotStops.forEach((s) => { if (!s.isMeal) num += 1; pushStop(s, num); });
      });
      if (d !== days[days.length - 1]) {
        const lod = lodging[d - 1] ?? lodging[0];
        nodes.push({
          tone: 'sleep', icon: 'bedtime', title: lod?.name ?? '펫 동반 숙소',
          sub: `${d}박째 · 체리와 취침`,
          reason: lod ? '반려동물 동반 숙소에서 하룻밤 묵어요. 대형견 체리도 함께 잘 수 있어요.' : `이날은 ${region}에서 1박 — 펫 동반 숙소를 추천했어요.`,
          source: lod?.source,
        });
      }
    });
  }

  const risk = safety ? (RISK_TONE[safety.risk_level] ?? RISK_TONE.moderate) : null;

  return (
    <div className="sc" style={css('flex:1; min-width:0; overflow-y:auto; padding:26px 30px 130px;')}>
      <div style={css('max-width:760px; margin:0 auto;')}>
        <div style={css('display:flex; align-items:flex-end; justify-content:space-between;')}>
          <div>
            <div style={css('font:800 24px Pretendard; letter-spacing:-0.02em;')}>{region} 펫 동반 여정</div>
            <div style={css('font:500 13px Pretendard; color:var(--muted); margin-top:6px;')}>체리 · 골든 리트리버 · 대형견 · 서울 → {region} · {transport} · {count}곳</div>
          </div>
          <span style={css(`font:700 12px Pretendard; color:${ready ? '#1B8A55' : 'var(--accent)'}; background:${ready ? 'rgba(34,165,101,.12)' : 'var(--accent-soft)'}; padding:7px 13px; border-radius:999px;`)}>{ready ? '준비 완료' : '작성 중'}</span>
        </div>

        {/* 오늘 전주 컨디션 — 실 날씨 위험도(더위 취약 체리 맞춤) */}
        {safety && risk && (
          <div style={css(`margin-top:18px; display:flex; align-items:center; gap:13px; background:var(--panel); border:1px solid var(--border); border-left:4px solid ${risk.c}; border-radius:16px; padding:15px 17px; box-shadow:var(--shadow);`)}>
            <div style={css(`width:42px; height:42px; border-radius:12px; background:${risk.bg}; color:${risk.c}; display:flex; align-items:center; justify-content:center; flex:none;`)}>
              <span className="msf" style={css('font-size:23px;')}>sunny</span>
            </div>
            <div style={css('flex:1; min-width:0;')}>
              <div style={css('display:flex; align-items:center; gap:8px;')}>
                <span style={css('font:800 15px Pretendard;')}>오늘 {region} {Math.round(safety.temperature_c)}°C · {safety.condition}</span>
                <span style={css(`font:700 10.5px Pretendard; color:${risk.c}; background:${risk.bg}; padding:3px 9px; border-radius:999px;`)}>{risk.label}</span>
              </div>
              <div style={css('font:500 12px Pretendard; color:var(--muted); margin-top:4px;')}>
                {safety.reasons?.length ? safety.reasons.join(' · ') : '체리는 더위에 약해요 — 그늘·수분을 자주 챙겨주세요.'}
              </div>
            </div>
          </div>
        )}

        {count === 0 && <div style={css('margin-top:30px; font:600 14px Pretendard; color:var(--muted);')}>아직 코스가 없어요. 플래너에서 만들어 보세요.</div>}

        {hasMock && (
          <div style={css('margin-top:16px; display:flex; align-items:center; gap:10px; background:rgba(217,138,0,.08); border:1px solid rgba(217,138,0,.25); border-radius:14px; padding:12px 15px;')}>
            <span className="msr" style={css('font-size:19px; color:#B26A00;')}>info</span>
            <div style={css('font:600 12px Pretendard; color:#8A5600; line-height:1.5;')}>일부 항목은 실데이터가 부족해 <b>MVP 데모용 예시(예시 · MVP 전용)</b>로 채웠어요. 정식 버전에선 실 공공데이터로 대체됩니다.</div>
          </div>
        )}

        {/* 단계 타임라인 */}
        <div style={css('margin-top:22px; position:relative;')}>
          {nodes.map((n, i) => {
            const ts = TONE_STYLE[n.tone];
            const last = i === nodes.length - 1;
            if (n.tone === 'day') {
              return (
                <div key={i} style={css('display:flex; align-items:center; gap:10px; margin:10px 0 14px 0;')}>
                  <span style={css('font:800 14px Pretendard; color:var(--accent);')}>{n.title}</span>
                  <div style={css('flex:1; height:1px; background:var(--border);')} />
                </div>
              );
            }
            if (n.tone === 'slot') {
              return (
                <div key={i} style={css('display:flex; align-items:center; gap:7px; margin:6px 0 12px 47px;')}>
                  <span className="msr" style={css('font-size:16px; color:var(--muted);')}>{n.icon}</span>
                  <span style={css('font:800 12.5px Pretendard; color:var(--text);')}>{n.title}</span>
                  {n.sub && <span style={css('font:600 11px Pretendard; color:var(--faint);')}>{n.sub}</span>}
                </div>
              );
            }
            return (
              <div key={i} style={css('display:flex; gap:15px;')}>
                <div style={css('display:flex; flex-direction:column; align-items:center; flex:none;')}>
                  <div style={css(`width:32px; height:32px; border-radius:50%; background:${ts.bg}; color:${ts.fg}; display:flex; align-items:center; justify-content:center; font:800 12px Pretendard; flex:none;`)}>
                    {n.num != null ? n.num : <span className="msf" style={css('font-size:17px;')}>{n.icon}</span>}
                  </div>
                  {!last && <div style={css('width:2px; flex:1; background:var(--border); margin:4px 0; min-height:14px;')} />}
                </div>
                <div
                  onClick={n.onClick}
                  style={css(`flex:1; min-width:0; background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:13px 16px; margin-bottom:14px; box-shadow:var(--shadow); ${n.onClick ? 'cursor:pointer;' : ''}`)}
                >
                  {n.isMeal && n.imageUrl && (
                    <img
                      src={n.imageUrl} alt={n.title} loading="lazy"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      style={css('width:100%; height:130px; object-fit:cover; border-radius:11px; margin-bottom:11px; display:block;')}
                    />
                  )}
                  <div style={css('display:flex; align-items:center; gap:9px; flex-wrap:wrap;')}>
                    {n.isMeal && <span className="msr" style={css('font-size:16px; color:#E8862B;')}>restaurant</span>}
                    {n.time && <span style={css('font:700 11px Pretendard; color:var(--accent);')}>{n.time}</span>}
                    <span style={css('font:700 15px Pretendard;')}>{n.title}</span>
                    {n.isMock && (
                      <span title="MVP 데모용 예시 데이터입니다(실데이터 아님)" style={css('font:700 10.5px Pretendard; color:#B26A00; background:rgba(217,138,0,.14); padding:3px 9px; border-radius:999px;')}>예시 · MVP 전용</span>
                    )}
                    {n.similarity != null && n.similarity > 0 && (
                      <span style={css('font:700 10.5px Pretendard; color:var(--accent); background:var(--accent-soft); padding:3px 9px; border-radius:999px;')}>닮은친구 {n.similarity}%</span>
                    )}
                    {n.onRemove && (
                      <span
                        onClick={(e) => { e.stopPropagation(); n.onRemove!(); }}
                        style={css('margin-left:auto; display:inline-flex; align-items:center; gap:3px; font:700 11px Pretendard; color:#D23B34; background:rgba(210,59,52,.1); padding:5px 10px; border-radius:999px; cursor:pointer;')}
                      >
                        <span className="msr" style={css('font-size:14px;')}>remove_circle_outline</span>제외
                      </span>
                    )}
                  </div>
                  {n.sub && <div style={css('font:500 12px Pretendard; color:var(--muted); margin-top:5px;')}>{n.sub}</div>}
                  {n.reason && <div style={css('font:500 12.5px Pretendard; color:var(--text); margin-top:8px; line-height:1.5;')}>{n.reason}</div>}
                  {n.badges && n.badges.length > 0 && (
                    <div style={css('display:flex; gap:6px; flex-wrap:wrap; margin-top:9px;')}>
                      {n.badges.map((b) => (
                        <span key={b} style={css('font:600 10.5px Pretendard; color:var(--muted); background:var(--chip); padding:4px 9px; border-radius:999px;')}>{b}</span>
                      ))}
                    </div>
                  )}
                  {n.isMeal && (n.phone || n.address) && (
                    <div style={css('display:flex; gap:7px; flex-wrap:wrap; margin-top:9px;')}>
                      {n.phone && (
                        <span style={css('display:inline-flex; align-items:center; gap:4px; font:600 11px Pretendard; color:var(--muted); background:var(--chip); padding:4px 9px; border-radius:999px;')}>
                          <span className="msr" style={css('font-size:13px;')}>call</span>{n.phone}
                        </span>
                      )}
                      {n.address && (
                        <span style={css('display:inline-flex; align-items:center; gap:4px; font:600 11px Pretendard; color:var(--muted); background:var(--chip); padding:4px 9px; border-radius:999px; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;')}>
                          <span className="msr" style={css('font-size:13px;')}>place</span>{n.address}
                        </span>
                      )}
                    </div>
                  )}
                  {(n.dist != null && n.dist > 0) || n.source ? (
                    <div style={css('font:400 10.5px Pretendard; color:var(--faint); margin-top:9px;')}>
                      {n.dist != null && n.dist > 0 ? `이전에서 ${n.dist}km` : ''}{n.dist != null && n.dist > 0 && n.source ? ' · ' : ''}{n.source ? `출처: ${n.source}` : ''}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        {/* 응급 푸터 — 경로 인근 응급 동물병원(행안부 표준데이터) */}
        {count > 0 && (
          <div
            onClick={onEmergency}
            style={css('margin-top:6px; display:flex; align-items:center; gap:13px; background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:15px 17px; box-shadow:var(--shadow); cursor:pointer;')}
          >
            <div style={css('width:42px; height:42px; border-radius:12px; background:rgba(255,107,92,.12); color:#FF6B5C; display:flex; align-items:center; justify-content:center; flex:none;')}>
              <span className="msf" style={css('font-size:22px;')}>emergency</span>
            </div>
            <div style={css('flex:1; min-width:0;')}>
              <div style={css('font:800 14px Pretendard;')}>여행 중 응급 상황이라면</div>
              <div style={css('font:500 12px Pretendard; color:var(--muted); margin-top:3px;')}>
                {safety?.nearest_hospital ? `가장 가까운 병원 · ${safety.nearest_hospital}${safety.nearest_hospital_km != null ? ` ${safety.nearest_hospital_km}km` : ''}` : `${region} 인근 동물병원을 거리순으로 안내해요`}
              </div>
            </div>
            <span className="msr" style={css('font-size:20px; color:var(--muted); flex:none;')}>chevron_right</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Dog() {
  const [visited, setVisited] = useState<VisitedPlace[]>([]);
  useEffect(() => {
    getVisitedPlaces(1).then(setVisited).catch(() => setVisited([]));
  }, []);
  const regions = new Set(visited.map((v) => v.region).filter(Boolean)).size;
  const totalVisits = visited.reduce((s, v) => s + v.visit_count, 0);

  return (
    <div className="sc" style={css('flex:1; min-width:0; overflow-y:auto; padding:26px 30px 130px;')}>
      <div style={css('max-width:880px; margin:0 auto;')}>
        <div style={css('display:flex; gap:18px; align-items:center; background:var(--panel); border:1px solid var(--border); border-radius:20px; padding:22px; box-shadow:var(--shadow);')}>
          <img src="/pet-persona.png" alt="체리" style={css('width:84px; height:84px; border-radius:50%; object-fit:cover; background:linear-gradient(135deg,#F8D9A8,#EBB06A); flex:none;')} />
          <div style={css('flex:1;')}>
            <div style={css('font:800 22px Pretendard;')}>체리</div>
            <div style={css('font:500 13px Pretendard; color:var(--muted); margin-top:2px;')}>골든 리트리버 · 28kg · 3살</div>
            <div style={css('display:flex; gap:7px; flex-wrap:wrap; margin-top:11px;')}>
              <span style={css('font:600 12px Pretendard; background:var(--chip); padding:7px 12px; border-radius:999px;')}>대형견</span>
              <span style={css('font:600 12px Pretendard; background:var(--chip); padding:7px 12px; border-radius:999px;')}>사교형</span>
              <span style={css('display:inline-flex; align-items:center; gap:4px; font:600 12px Pretendard; background:rgba(255,107,92,.12); color:#FF6B5C; padding:7px 12px; border-radius:999px;')}>
                <span className="msf" style={css('font-size:13px;')}>sunny</span>더위 취약
              </span>
            </div>
          </div>
        </div>
        <div style={css('margin-top:18px;')}>
          <div style={css('background:var(--panel); border:1px solid var(--border); border-radius:18px; padding:18px; box-shadow:var(--shadow);')}>
            <div style={css('display:flex; align-items:center; gap:8px; font:800 15px Pretendard;')}><span className="msf" style={css('font-size:18px; color:var(--accent);')}>map</span>발자국 지도</div>
            <FootprintMap places={visited} />
            <div style={css('display:flex; gap:18px; margin-top:12px;')}>
              {[[String(visited.length), '다녀온 곳'], [`${totalVisits}회`, '방문'], [String(regions), '지역']].map(([n, l]) => (
                <div key={l}><div style={css('font:800 18px Pretendard; color:var(--accent);')}>{n}</div><div style={css('font:500 11px Pretendard; color:var(--muted);')}>{l}</div></div>
              ))}
            </div>
            <div style={css('font:400 10.5px Pretendard; color:var(--faint); margin-top:10px;')}>데이터: 방문기록 집계(실좌표)</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// 발자국 지도 — 실 방문기록 좌표를 박스 안에 정규화해 핀 표시(실 GPS 아님, 데이터셋 좌표).
function FootprintMap({ places }: { places: VisitedPlace[] }) {
  const pts = places.slice(0, 12);
  if (pts.length === 0) {
    return <div style={css('height:150px; border-radius:13px; background:var(--map); margin-top:12px; display:flex; align-items:center; justify-content:center; font:600 12px Pretendard; color:var(--muted);')}>아직 다녀온 곳이 없어요</div>;
  }
  const lats = pts.map((p) => p.latitude), lngs = pts.map((p) => p.longitude);
  const minLa = Math.min(...lats), maxLa = Math.max(...lats), minLo = Math.min(...lngs), maxLo = Math.max(...lngs);
  const nx = (lo: number) => (maxLo === minLo ? 50 : 12 + ((lo - minLo) / (maxLo - minLo)) * 76);
  const ny = (la: number) => (maxLa === minLa ? 50 : 82 - ((la - minLa) / (maxLa - minLa)) * 64);
  return (
    <div style={css('height:150px; border-radius:13px; background:var(--map); position:relative; overflow:hidden; margin-top:12px;')}>
      <svg viewBox="0 0 300 150" style={css('position:absolute; inset:0; width:100%; height:100%;')}>
        <path d="M20 50 H280 M120 10 V140 M210 10 V140" stroke="var(--map-road)" strokeWidth="7" fill="none" />
      </svg>
      {pts.map((p) => (
        <div key={p.facility_id} title={`${p.name} · ${p.visit_count}회`} style={css(`position:absolute; left:${nx(p.longitude)}%; top:${ny(p.latitude)}%; transform:translate(-50%,-100%);`)}>
          <div style={css(`width:${16 + Math.min(p.visit_count, 4) * 3}px; height:${16 + Math.min(p.visit_count, 4) * 3}px; border-radius:50% 50% 50% 3px; background:var(--accent); box-shadow:0 3px 9px rgba(59,91,254,.4); display:flex; align-items:center; justify-content:center;`)}>
            <span className="msf" style={css('font-size:9px; color:#fff;')}>pets</span>
          </div>
        </div>
      ))}
    </div>
  );
}

const LV = {
  allowed: { c: '#1B8A55', bg: 'rgba(34,165,101,.12)', icon: 'verified', label: '입장 가능' },
  conditional: { c: '#C98A00', bg: 'rgba(201,138,0,.12)', icon: 'rule', label: '조건부 가능' },
  denied: { c: '#D23B34', bg: 'rgba(210,59,52,.12)', icon: 'block', label: '동반 불가' },
} as const;

// 실데이터 상세 — 백엔드 실 장소이므로 entry-verdict·review 가 정상 동작.
function LiveDetail({ stop, region, hasCourse, inCourse, reviews, onAdd, onClose, onItin }: { stop: Place; region: string; hasCourse: boolean; inCourse: boolean; reviews: Review[]; onAdd: () => void; onClose: () => void; onItin: () => void }) {
  const [verdict, setVerdict] = useState<EntryVerdictResult | null>(null);
  useEffect(() => {
    if (!hasCourse) return;
    let on = true;
    setVerdict(null);
    // 목업(예시) 정류장은 실데이터가 아니라 입장 판정을 건너뛴다(잘못된 '시설 못 찾음' 방지).
    if (stop.isMock) return;
    checkEntry({ region, place_name: stop.name, pet_name: '체리', pet_size: 'large' })
      .then((v) => on && setVerdict(v))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [stop.name, hasCourse, region, stop.isMock]);

  if (!hasCourse) {
    return (
      <div style={css('flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:40px; text-align:center; gap:10px;')}>
        <span className="msf" style={css('font-size:44px; color:var(--faint);')}>map</span>
        <div style={css('font:700 15px Pretendard;')}>아직 코스가 없어요</div>
        <div style={css('font:500 13px Pretendard; color:var(--muted); line-height:1.6;')}>채팅에서 "전주로 갈거야"라고 말하면<br />실 공공데이터로 코스를 짜드려요.</div>
      </div>
    );
  }

  const lv = verdict ? LV[verdict.verdict] : null;
  const avg = reviews.length ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1) : null;

  return (
    <>
      <div style={css('display:flex; align-items:center; gap:10px; padding:16px 18px 12px; flex:none;')}>
        <div onClick={onItin} style={css('display:flex; align-items:center; gap:7px; cursor:pointer;')}>
          <span className="msr" style={css('font-size:20px; color:var(--muted);')}>arrow_back</span>
          <span style={css('font:700 14px Pretendard;')}>{stop.day} · {region} 코스</span>
        </div>
        <div onClick={onClose} style={css('margin-left:auto; width:30px; height:30px; border-radius:9px; background:var(--panel); display:flex; align-items:center; justify-content:center; color:var(--muted); cursor:pointer;')}>
          <span className="msr" style={css('font-size:18px;')}>close</span>
        </div>
      </div>
      <div style={css('padding:0 18px;')}>
        <div style={css(`height:200px; border-radius:18px; background:${stop.grad}; position:relative; overflow:hidden; display:flex; align-items:center; justify-content:center;`)}>
          <div style={css('position:absolute; inset:0; background-image:repeating-linear-gradient(135deg, rgba(255,255,255,.10) 0 12px, rgba(255,255,255,0) 12px 24px);')} />
          <span className="msf" style={css('font-size:54px; color:rgba(255,255,255,.6);')}>{stop.icon}</span>
          <span style={css(`position:absolute; bottom:12px; left:14px; font:600 11px ui-monospace,monospace; color:rgba(255,255,255,.92); background:${stop.isMock ? 'rgba(178,106,0,.55)' : 'rgba(0,0,0,.22)'}; padding:5px 10px; border-radius:8px;`)}>{stop.isMock ? '예시 · MVP 전용' : '실데이터'} · {stop.cat}</span>
        </div>
        <div style={css('display:flex; align-items:center; gap:9px; margin-top:16px; flex-wrap:wrap;')}>
          <div style={css('font:800 22px Pretendard; letter-spacing:-0.02em;')}>{stop.name}</div>
          {stop.isMock && <span title="MVP 데모용 예시 데이터입니다(실데이터 아님)" style={css('font:700 11px Pretendard; color:#B26A00; background:rgba(217,138,0,.14); padding:4px 10px; border-radius:999px;')}>예시 · MVP 전용</span>}
          {avg && <span style={css('display:inline-flex; align-items:center; gap:3px; font:700 13px Pretendard;')}><span className="msf" style={css('font-size:15px; color:#F5B400;')}>star</span>{avg}</span>}
        </div>
        <div style={css('font:600 12.5px Pretendard; color:var(--muted); margin-top:7px;')}>{stop.cat}</div>
      </div>
      <div style={css('padding:18px; flex:1;')}>
        {lv && (
          <div style={css(`display:flex; align-items:center; gap:10px; background:${lv.bg}; border-radius:13px; padding:13px 15px;`)}>
            <span className="msf" style={css(`font-size:20px; color:${lv.c};`)}>{lv.icon}</span>
            <div>
              <div style={css(`font:800 14px Pretendard; color:${lv.c};`)}>체리 · {lv.label}</div>
              <div style={css('font:500 12px Pretendard; color:var(--text); margin-top:2px; line-height:1.5;')}>{verdict!.message}</div>
            </div>
          </div>
        )}
        {verdict && verdict.conditions.length > 0 && (
          <div style={css('margin-top:12px; display:flex; flex-direction:column; gap:7px;')}>
            {verdict.conditions.map((cond, i) => (
              <div key={i} style={css('display:flex; gap:8px; align-items:flex-start; font:500 13px Pretendard;')}>
                <span className="msr" style={css('font-size:17px; color:var(--accent); margin-top:1px;')}>check_circle</span>{cond}
              </div>
            ))}
          </div>
        )}
        {verdict && verdict.alternatives && verdict.alternatives.length > 0 && (
          <div style={css('margin-top:14px; background:var(--accent-soft); border:1px solid var(--border); border-radius:13px; padding:13px 15px;')}>
            <div style={css('display:flex; align-items:center; gap:7px; font:800 13px Pretendard; color:var(--accent);')}>
              <span className="msf" style={css('font-size:16px;')}>alt_route</span>체리가 못 들어가요 · 대신 가까운 곳
            </div>
            <div style={css('display:flex; flex-direction:column; gap:8px; margin-top:10px;')}>
              {verdict.alternatives.map((a, i) => (
                <div key={i} style={css('display:flex; align-items:center; gap:9px; background:var(--panel); border-radius:10px; padding:9px 11px;')}>
                  <span className="msf" style={css('font-size:16px; color:var(--accent);')}>pets</span>
                  <div style={css('min-width:0;')}>
                    <div style={css('font:700 13px Pretendard; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;')}>{a.name}</div>
                    <div style={css('font:500 11px Pretendard; color:var(--muted); margin-top:1px;')}>{a.category}</div>
                  </div>
                  <span style={css('margin-left:auto; font:600 11.5px Pretendard; color:var(--text); flex:none;')}>{a.distance_km < 1 ? `${Math.round(a.distance_km * 1000)}m` : `${a.distance_km}km`}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {stop.desc && (
          <>
            <div style={css('font:800 15px Pretendard; margin:18px 0 9px;')}>추천 이유</div>
            <div style={css('font:500 13.5px Pretendard; line-height:1.7; color:var(--muted);')}>{stop.desc}</div>
          </>
        )}
        <div style={css('font:800 15px Pretendard; margin:20px 0 11px;')}>보호자 후기 {reviews.length}건 · 실데이터</div>
        <div style={css('display:flex; flex-direction:column; gap:11px;')}>
          {reviews.length === 0 && <div style={css('font:500 12.5px Pretendard; color:var(--muted);')}>아직 등록된 후기가 없어요.</div>}
          {reviews.map((rv) => (
            <div key={rv.id} style={css('background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:14px;')}>
              <div style={css('display:flex; align-items:center; gap:6px;')}>
                <div style={css('font:700 13px Pretendard; flex:1;')}>{rv.title}</div>
                <span className="msf" style={css('font-size:13px; color:#F5B400;')}>star</span>
                <span style={css('font:700 12px Pretendard;')}>{rv.rating}</span>
              </div>
              <div style={css('font:500 12.5px Pretendard; color:var(--muted); margin-top:5px; line-height:1.6;')}>{rv.body}</div>
              <div style={css('font:400 11px Pretendard; color:var(--faint); margin-top:7px;')}>{rv.author} · {rv.source}</div>
            </div>
          ))}
        </div>
        <div style={css('font:400 11px Pretendard; color:var(--faint); margin-top:16px;')}>데이터: {stop.source} · 입장 판정은 규칙으로 확인</div>
      </div>
      <div style={css('padding:0 18px 18px; flex:none;')}>
        <div onClick={onAdd} style={css(`font:700 14.5px Pretendard; text-align:center; padding:14px; border-radius:14px; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; ${inCourse ? 'background:rgba(210,59,52,.1); color:#D23B34;' : 'background:var(--accent); color:#fff;'}`)}>
          <span className="msf" style={css('font-size:19px;')}>{inCourse ? 'remove_circle_outline' : 'add_location_alt'}</span>{inCourse ? '코스에서 제외' : '이 장소 코스에 담기'}
        </div>
      </div>
    </>
  );
}
