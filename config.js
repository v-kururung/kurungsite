/* ═══════════════════════════════════════════════════════════
   사이트 설정 파일
   ───────────────────────────────────────────────────────────
   이 파일만 수정하면 사이트 전체가 바뀝니다.
   다른 파일(html, css, js)은 건드릴 필요 없어요.

   ※ 문구 안에 {name} 을 쓰면 아래 profile 의 이름으로 자동 치환됩니다.
      예: '{name}에게 하고 싶은 말을 남겨주세요' → '쿠룽v에게 하고 싶은 말을…'
   ═══════════════════════════════════════════════════════════ */

window.SITE_CONFIG = {

  /* ───── 1. 기본 정보 ───── */
  site: {
    tabTitle : '{name}',           // 브라우저 탭 이름
    logoText : '{name}',           // 좌측 상단 로고
    footer   : '© {year} {name}',  // 하단 문구 ({year} = 올해 자동)

    /* 제작자 크레딧 — 필요 없으면 credit 을 '' 로 비우세요 */
    credit    : 'Site by 쿠룽v',
    creditUrl : ''                 // 클릭 시 이동할 주소 (없으면 '')
  },


  /* ───── 2. 색상 테마 ─────
     여기 색만 바꾸면 사이트 전체 분위기가 바뀝니다 */
  theme: {
    main      : '#f6b7d8',   // 메인 (버튼, 강조, 오늘 날짜)
    mainDeep  : '#ee9bc6',   // 메인 진한색 (호버, 포인트 텍스트)
    mainSoft  : '#ffe3f1',   // 메인 연한색 (태그 배경)
    accent    : '#ffd86b',   // 포인트 (특별한 날 강조)
    accentSoft: '#fff0c6',   // 포인트 연한색 (말풍선 배경)
    sub2      : '#ebd8ff',   // 보조 (버튼 호버 등)

    page      : '#fff9fc',   // 페이지 배경
    card      : '#ffffff',   // 카드 배경
    text      : '#413a48',   // 본문 글자
    textSub   : '#867a83',   // 보조 글자 (날짜, 라벨)
    line      : '#fbe9f2'    // 구분선, 테두리
  },


  /* ───── 3. 폰트 ─────
     구글 폰트 이름 그대로 (fonts.google.com 에서 확인) */
  fonts: {
    display : 'Jua',            // 로고, 제목
    body    : 'Gowun Dodum',    // 본문
    hand    : 'Gamja Flower',   // 손글씨 (말풍선)
    latin   : 'Poppins'         // 영문, 숫자
  },


  /* ───── 4. 상단 메뉴 ─────
     필요 없는 메뉴는 줄 삭제, 추가하려면 줄 복사 */
  menu: [
    { label: '메인',         href: 'index.html'   },
    { label: '방송 히스토리', href: 'summary.html' },
    { label: '월간쿠룽',      href: 'monthly.html' },
    { label: '주문내역',      href: 'orders.html'  }
  ],


  /* ───── 5. 프로필 ───── */
  profile: {
    image     : 'profile.png',   // 프로필 사진 파일명 (권장 720×1000px)
    nameMain  : '쿠룽',           // 이름
    nameAccent: 'v',             // 이름 뒤 강조 부분 (없으면 '')
    hearts    : 5,               // 하트 개수

    /* 프로필 항목 — 자유롭게 추가/삭제/순서변경 가능
       highlight: true  → 값을 강조색으로
       dday: true       → 값 옆에 D-day 뱃지 표시 */
    rows: [
      { key: '종족',        value: '선녀' },
      { key: '나이',        value: '1,000살' },
      { key: '데뷔일',      value: '2026년 8월 1일', highlight: true, dday: true },
      { key: '팬덤명',      value: '나무꾼 🌲' },
      { key: '팬 고정닉',   value: '/l/닉네임' },
      { key: '주요 컨텐츠', value: '소통 · 종합게임' }
    ],

    debutDate : '2026-08-01',    // D-day 계산 기준일 (YYYY-MM-DD)
    bubble    : '나 쫌 귀여운데 일단 앉아볼래? 🌙'   // 말풍선 (없으면 '')
  },


  /* ───── 6. 링크 버튼 ─────
     icon: 이미지 파일명 또는 이모지
     url : 주소 ('inquiry' 로 두면 문의창이 열립니다) */
  links: [
    { icon: 'soop.png',    label: '숲',     url: 'https://www.sooplive.com/station/kururung' },
    { icon: 'youtube.png', label: '유튜브',  url: 'https://www.youtube.com/@%EC%BF%A0%EB%A3%BDv' },
    { icon: '✉️',          label: '문의',    url: 'inquiry' }
  ],


  /* ───── 7. 구글 캘린더 ─────
     설정 방법은 SETUP.md 참고
     · Google Cloud Console 에서 API 키 발급
     · 캘린더를 '공개'로 설정
     · 캘린더 ID는 캘린더 설정 > 캘린더 통합 에서 확인 */
  calendar: {
    apiKey      : 'AIzaSyCbtvWOOuF45tUqRlaEeMlW6i5n-17deLE',
    calendarId  : 'v.kururung@gmail.com',
    timezone    : 'Asia/Seoul',
    pollMinutes : 60,                    // 자동 새로고침 주기(분)
    sectionTitle: '이번주 일정',
    specialDate : '2026-08-01',          // 특별 강조할 날 (데뷔일 등, 없으면 '')
    emptyText   : '—'                    // 일정 없는 날 표시
  },


  /* ───── 8. 방송 히스토리 페이지 ───── */
  broadcast: {
    sectionTitle: '방송 히스토리',
    perPage     : 20,      // 한 페이지에 보여줄 개수
    searchHint  : '제목·태그 검색',
    emptyText   : '아직 등록된 방송이 없어요 🍃',
    replayLabel : '다시보기',

    /* 다시보기 버튼 — 순서대로 표시됩니다.
       field: 데이터에 저장된 주소 항목 이름
       링크가 등록되지 않은 항목은 자동으로 비활성 처리됩니다 */
    platforms: [
      { field: 'soop_url',    label: '숲',    icon: 'soop.png'    },
      { field: 'youtube_url', label: '유튜브', icon: 'youtube.png' }
    ],
    soonText: '아직 {label} 다시보기가 올라오지 않았어요.'
  },


  /* ───── 9. 화보집 페이지 ───── */
  gallery: {
    sectionEn    : 'Monthly Kurung',
    sectionTitle : '월간쿠룽',
    thumbsPerRow : 5,       // 썸네일 한 줄 개수
    maxHeight    : 640,     // 사진 최대 높이(px)
    emptyText    : '아직 등록된 화보가 없어요 🍃'
  },


  /* ───── 10. 문의창 ───── */
  inquiry: {
    title       : '✉️ 문의하기',
    description : '{name}에게 하고 싶은 말을 남겨주세요 🌿',
    nickLabel   : '닉네임 (필수)',
    contactLabel: '답장받을 이메일',
    messageLabel: '문의 내용을 적어주세요',
    sendLabel   : '보내기 🌿',
    doneText    : '보냈어요! 💌'
  },


  /* ───── 11. 배경 효과 ───── */
  effects: {
    enabled : true,                        // false 로 두면 배경 반짝임 꺼짐
    glyphs  : ['✦','♡','✧','⋆','☁'],       // 떠다닐 문자
    count   : 14                           // 개수
  },


  /* ───── 12. API 주소 ─────
     Cloudflare Pages 에 함께 배포되므로 기본값 그대로 두면 됩니다 */
  apiBase: '/api'

};
