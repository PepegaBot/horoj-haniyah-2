export const ADMIN_DISCORD_ID = "217998454197190656";

export const PHASES = {
  LOBBY: "LOBBY",
  PROMPT_REVEAL: "PROMPT_REVEAL",
  GIF_SEARCH: "GIF_SEARCH",
  VOTING: "VOTING",
  ROUND_RESULTS: "ROUND_RESULTS",
} as const;

export type Phase = (typeof PHASES)[keyof typeof PHASES];
export type Language = "en" | "ar";
export type DeckMode = "DEFAULT" | "CUSTOM" | "MIXED";

export type Prompt = {
  id: string;
  en: string;
  ar: string;
  source: "default" | "custom";
};

export type GifAsset = {
  id: string;
  url: string;
  previewUrl: string;
  title?: string;
};

export type PodiumEntry = {
  rank: number;
  playerId: string;
  username: string;
  votes: number;
  gif: GifAsset;
  isFirst: boolean;
};

export type RevealStep = {
  rank: number;
  revealAtMs: number;
};

export type ResultsTimeline = {
  prompt: Prompt | null;
  podium: PodiumEntry[];
  revealSchedule: RevealStep[];
  phaseEndsAt: number | null;
};

export type VoteOption = {
  targetPlayerId: string;
  gif: GifAsset;
};

export type PlayerView = {
  id: string;
  username: string;
  avatarUrl: string | null;
  isAdmin: boolean;
  score: number;
};

export type RoomStateView = {
  roomId: string;
  phase: Phase;
  phaseEndsAt: number | null;
  roundNumber: number;
  deckMode: DeckMode;
  minPlayers: number;
  canStartRound: boolean;
  currentPrompt: Prompt | null;
  customPromptCount: number;
  players: PlayerView[];
  submissionsCount: number;
  votesCount: number;
  voteOptions: VoteOption[];
  rankedResults: PodiumEntry[];
};

export const i18n = {
  en: {
    title: "Horoj Haniya",
    subtitle: "GIF Reaction Party",
    languageLabel: "Language",
    lobby: "Lobby",
    promptReveal: "Prompt Reveal",
    gifSearch: "GIF Search",
    voting: "Voting",
    results: "Results",
    deckMode: "Deck Mode",
    minPlayers: "Min Players",
    addPrompt: "Add Prompt",
    startRound: "Start Round",
    enPrompt: "Prompt (EN)",
    arPrompt: "Prompt (AR)",
    submitPrompt: "Save Custom Prompt",
    customCount: "Custom Prompts",
    searchGifs: "Search GIFs",
    searchPlaceholder: "Type keywords...",
    search: "Search",
    loadMore: "Load More",
    submitGif: "Submit GIF",
    voteNow: "Vote",
    waitingVotes: "Waiting for votes...",
    voteCount: "Votes",
    players: "Players",
    scoreboard: "Scoreboard",
    room: "Room",
    connected: "Connected",
    disconnected: "Disconnected",
    onlyAdmin: "Admin controls",
    noPrompt: "No prompt selected yet",
    noResults: "No results yet",
    winner: "Winner",
    selectDeck: "Select Active Deck",
    setMinPlayers: "Set Minimum Players",
    searchHint: "Find the perfect reaction before time runs out",
    voteHint: "Pick the funniest GIF (no self-votes)",
    resultsHint: "Podium reveal",
    submitting: "Submitting...",
    searching: "Searching...",
    noGifResults: "No GIFs found",
  },
  ar: {
    title: "هروج هانيه",
    subtitle: "لعبة تفاعل الـ GIF",
    languageLabel: "اللغة",
    lobby: "اللوبي",
    promptReveal: "عرض السؤال",
    gifSearch: "بحث GIF",
    voting: "التصويت",
    results: "النتائج",
    deckMode: "نوع الدِك",
    minPlayers: "الحد الأدنى",
    addPrompt: "إضافة سؤال",
    startRound: "ابدأ الجولة",
    enPrompt: "السؤال (EN)",
    arPrompt: "السؤال (AR)",
    submitPrompt: "حفظ السؤال المخصص",
    customCount: "الأسئلة المخصصة",
    searchGifs: "ابحث عن GIF",
    searchPlaceholder: "اكتب كلمات البحث...",
    search: "بحث",
    loadMore: "تحميل المزيد",
    submitGif: "إرسال GIF",
    voteNow: "تصويت",
    waitingVotes: "بانتظار التصويت...",
    voteCount: "الأصوات",
    players: "اللاعبون",
    scoreboard: "لوحة النقاط",
    room: "الغرفة",
    connected: "متصل",
    disconnected: "غير متصل",
    onlyAdmin: "تحكم الأدمن",
    noPrompt: "لا يوجد سؤال حالياً",
    noResults: "لا توجد نتائج بعد",
    winner: "الفائز",
    selectDeck: "اختر الدِك النشط",
    setMinPlayers: "حدد الحد الأدنى",
    searchHint: "اختر أفضل رد قبل انتهاء الوقت",
    voteHint: "اختر أضحك GIF (بدون تصويت لنفسك)",
    resultsHint: "كشف منصة الفائزين",
    submitting: "جارٍ الإرسال...",
    searching: "جارٍ البحث...",
    noGifResults: "ما في نتائج GIF",
  },
} as const;

export function phaseLabelKey(phase: Phase): keyof typeof i18n.en {
  switch (phase) {
    case PHASES.LOBBY:
      return "lobby";
    case PHASES.PROMPT_REVEAL:
      return "promptReveal";
    case PHASES.GIF_SEARCH:
      return "gifSearch";
    case PHASES.VOTING:
      return "voting";
    case PHASES.ROUND_RESULTS:
      return "results";
    default:
      return "lobby";
  }
}

export function getAudioCueForPhase(phase: Phase): string {
  switch (phase) {
    case PHASES.LOBBY:
      return "lobby_music.mp3";
    case PHASES.PROMPT_REVEAL:
      return "round_start.mp3";
    case PHASES.GIF_SEARCH:
      return "search_phase_ticking.mp3";
    case PHASES.VOTING:
      return "voting_music.mp3";
    case PHASES.ROUND_RESULTS:
      return "round_winner.mp3";
    default:
      return "lobby_music.mp3";
  }
}

export function getVisibleRanks(
  revealSchedule: RevealStep[],
  elapsedMs: number,
): number[] {
  return revealSchedule
    .filter((step) => elapsedMs >= step.revealAtMs)
    .map((step) => step.rank)
    .sort((a, b) => a - b);
}
