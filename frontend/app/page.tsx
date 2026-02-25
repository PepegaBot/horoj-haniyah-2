"use client";

import { AnimatePresence, motion } from "framer-motion";
import { DiscordSDK, patchUrlMappings } from "@discord/embedded-app-sdk";
import { io, Socket } from "socket.io-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ADMIN_DISCORD_ID,
  type DeckMode,
  type GifAsset,
  getAudioCueForPhase,
  i18n,
  type Language,
  phaseLabelKey,
  PHASES,
  type PodiumEntry,
  type ResultsTimeline,
  type RoomStateView,
} from "./game-helpers";

const BACKEND_BASE_URL =
  process.env.NEXT_PUBLIC_BACKEND_BASE_URL || "http://localhost:3001";
const URL_MAPPING_PREFIX =
  process.env.NEXT_PUBLIC_URL_MAPPING_PREFIX || "/proxy";
const ADMIN_OVERRIDE_IDS = String(
  process.env.NEXT_PUBLIC_ADMIN_OVERRIDE_IDS || "",
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const INITIAL_ROOM_STATE: RoomStateView = {
  roomId: "local-room",
  phase: PHASES.LOBBY,
  phaseEndsAt: null,
  roundNumber: 0,
  deckMode: "DEFAULT",
  minPlayers: 3,
  canStartRound: false,
  currentPrompt: null,
  customPromptCount: 0,
  players: [],
  submissionsCount: 0,
  votesCount: 0,
  voteOptions: [],
  rankedResults: [],
};

function getQueryParam(name: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return new URLSearchParams(window.location.search).get(name);
}

function isDiscordActivityRuntime() {
  if (typeof window === "undefined") {
    return false;
  }
  const host = window.location.hostname.toLowerCase();
  if (host.endsWith(".discordsays.com")) {
    return true;
  }
  const params = new URLSearchParams(window.location.search);
  const activityKeys = [
    "frame_id",
    "instance_id",
    "platform",
    "channel_id",
    "guild_id",
    "location_id",
  ];
  return activityKeys.some((key) => params.has(key));
}

function trimTrailingSlash(path: string) {
  if (!path) {
    return "";
  }
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function buildDiscordAvatarUrl(userId: string, avatarHash: string | null | undefined) {
  if (!avatarHash) {
    return null;
  }
  if (avatarHash.startsWith("http://") || avatarHash.startsWith("https://")) {
    return avatarHash;
  }
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=128`;
}

function normalizeName(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function resolveIdentityFromParticipants(
  participants: Array<{
    id: string;
    username?: string | null;
    global_name?: string | null;
    nickname?: string | null;
    avatar?: string | null;
  }>,
  fallbackUserName: string,
  explicitUserId: string | null,
) {
  if (!participants.length) {
    return null;
  }

  if (explicitUserId) {
    const exact = participants.find((participant) => participant.id === explicitUserId);
    if (exact) {
      return {
        id: exact.id,
        username: exact.global_name || exact.nickname || exact.username || fallbackUserName,
        avatarUrl: buildDiscordAvatarUrl(exact.id, exact.avatar),
      };
    }
  }

  const wantedName = normalizeName(fallbackUserName);
  const byName = participants.filter((participant) => {
    const names = [
      normalizeName(participant.global_name),
      normalizeName(participant.nickname),
      normalizeName(participant.username),
    ].filter(Boolean);
    return names.includes(wantedName);
  });

  if (byName.length === 1) {
    const matched = byName[0];
    return {
      id: matched.id,
      username: matched.global_name || matched.nickname || matched.username || fallbackUserName,
      avatarUrl: buildDiscordAvatarUrl(matched.id, matched.avatar),
    };
  }

  if (participants.length === 1) {
    const only = participants[0];
    return {
      id: only.id,
      username: only.global_name || only.nickname || only.username || fallbackUserName,
      avatarUrl: buildDiscordAvatarUrl(only.id, only.avatar),
    };
  }

  return null;
}

async function getSdkParticipants(discordSdk: DiscordSDK) {
  try {
    const response = await discordSdk.commands.getActivityInstanceConnectedParticipants();
    return response.participants || [];
  } catch {
    const fallback = await discordSdk.commands.getInstanceConnectedParticipants();
    return fallback.participants || [];
  }
}

function resolveIdentityFromVoiceStates(
  voiceStates: Array<{
    user?: {
      id?: string;
      username?: string | null;
      global_name?: string | null;
      avatar?: string | null;
    };
    nick?: string | null;
  }>,
  fallbackUserName: string,
  explicitUserId: string | null,
) {
  const mapped: Array<{
    id: string;
    username?: string | null;
    global_name?: string | null;
    nickname?: string | null;
    avatar?: string | null;
  }> = voiceStates
    .map((state) => ({
      id: String(state.user?.id || ""),
      username: state.user?.username || null,
      global_name: state.user?.global_name || null,
      nickname: state.nick || null,
      avatar: state.user?.avatar || null,
    }))
    .filter((entry) => entry.id.length > 0);

  return resolveIdentityFromParticipants(mapped, fallbackUserName, explicitUserId);
}

function getOrCreateSessionGuestId() {
  if (typeof window === "undefined") {
    return `guest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  const key = "horoj_haniya_session_guest_id";
  const existing = window.sessionStorage.getItem(key);
  if (existing) {
    return existing;
  }
  const generated = `guest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  window.sessionStorage.setItem(key, generated);
  return generated;
}

function patchDiscordNetworkMappings(baseUrl: string) {
  const parsed = new URL(baseUrl);
  const targetPath = parsed.pathname.endsWith("/")
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;
  const target = `${parsed.host}${targetPath}`;
  patchUrlMappings(
    [{ prefix: URL_MAPPING_PREFIX, target }],
    {
      patchFetch: true,
      patchWebSocket: true,
      patchXhr: true,
    },
  );
}

function useGameAudio(phase: RoomStateView["phase"]) {
  useEffect(() => {
    switch (phase) {
      case PHASES.LOBBY:
        // const lobbyMusic = new Audio("/sounds/lobby_music.mp3");
        // void lobbyMusic.play();
        break;
      case PHASES.PROMPT_REVEAL:
        // const roundStart = new Audio("/sounds/round_start.mp3");
        // void roundStart.play();
        break;
      case PHASES.GIF_SEARCH:
        // const searchTicking = new Audio("/sounds/search_phase_ticking.mp3");
        // void searchTicking.play();
        break;
      case PHASES.VOTING:
        // const votingMusic = new Audio("/sounds/voting_music.mp3");
        // void votingMusic.play();
        break;
      case PHASES.ROUND_RESULTS:
        // const roundWinner = new Audio("/sounds/round_winner.mp3");
        // void roundWinner.play();
        break;
      default:
        break;
    }
  }, [phase]);

  return getAudioCueForPhase(phase);
}

export default function HomePage() {
  const [language, setLanguage] = useState<Language>("en");
  const [roomState, setRoomState] = useState<RoomStateView>(INITIAL_ROOM_STATE);
  const [roomId, setRoomId] = useState("local-room");
  const [me, setMe] = useState({
    id: "guest_local",
    username: "Local Player",
    avatarUrl: null as string | null,
  });
  const [isConnected, setIsConnected] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<GifAsset[]>([]);
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [selectedGif, setSelectedGif] = useState<GifAsset | null>(null);
  const [searching, setSearching] = useState(false);
  const [submittingGif, setSubmittingGif] = useState(false);
  const [hasVoted, setHasVoted] = useState(false);
  const [customPromptEn, setCustomPromptEn] = useState("");
  const [customPromptAr, setCustomPromptAr] = useState("");
  const [resultsTimeline, setResultsTimeline] = useState<ResultsTimeline | null>(
    null,
  );
  const [revealedRanks, setRevealedRanks] = useState<number[]>([]);
  const [useDiscordProxy, setUseDiscordProxy] = useState(false);
  const [urlUserId, setUrlUserId] = useState<string | null>(null);
  const [runtimeLabel, setRuntimeLabel] = useState("local");

  const socketRef = useRef<Socket | null>(null);
  const dict = i18n[language];
  const myPlayer = roomState.players.find((p) => p.id === me.id);
  const isAdmin = myPlayer?.isAdmin || me.id === ADMIN_DISCORD_ID || ADMIN_OVERRIDE_IDS.includes(me.id);
  const dir = language === "ar" ? "rtl" : "ltr";
  const activePhaseLabel = dict[phaseLabelKey(roomState.phase)];
  const backendApiBase = useMemo(() => {
    if (useDiscordProxy) {
      return trimTrailingSlash(URL_MAPPING_PREFIX) || "/proxy";
    }
    const parsed = new URL(BACKEND_BASE_URL);
    const basePath = parsed.pathname === "/" ? "" : trimTrailingSlash(parsed.pathname);
    return `${parsed.origin}${basePath}`;
  }, [useDiscordProxy]);

  useGameAudio(roomState.phase);

  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = language;
  }, [dir, language]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const inDiscordActivity = isDiscordActivityRuntime();
      const fallbackUserId = getQueryParam("user_id") || getOrCreateSessionGuestId();
      const fallbackUserName =
        getQueryParam("username") ||
        getQueryParam("global_name") ||
        getQueryParam("display_name") ||
        `Player ${fallbackUserId.slice(-4)}`;
      const fallbackRoomId = getQueryParam("channel_id") || "local-room";
      const explicitUrlUserId = getQueryParam("user_id") || getQueryParam("referrer_id");

      let nextUser = {
        id: fallbackUserId,
        username: fallbackUserName,
        avatarUrl: null as string | null,
      };
      let nextRoomId = fallbackRoomId;

      if (inDiscordActivity) {
        if (process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID) {
          try {
            const discordSdk = new DiscordSDK(
              process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID,
              { disableConsoleLogOverride: true },
            );
            await discordSdk.ready();

            nextRoomId = discordSdk.channelId || fallbackRoomId;
            nextUser.id = fallbackUserId;
            nextUser.username = fallbackUserName;
            setRuntimeLabel("discord");
            setUrlUserId(explicitUrlUserId);
            
            try {
              
              const { code } = await discordSdk.commands.authorize({
                client_id: process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID!,
                response_type: "code",
                state: "",
                prompt: "none",
                scope: ["identify", "guilds"],
              });

              const backendUrl = inDiscordActivity ? URL_MAPPING_PREFIX : BACKEND_BASE_URL;
              const tokenResponse = await fetch(`${backendUrl}/api/discord/token`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code }),
              });
              
              if (!tokenResponse.ok) throw new Error("Failed to fetch token from backend");
              
              const { access_token } = await tokenResponse.json();

              const authResult = await discordSdk.commands.authenticate({ access_token });

              if (authResult?.user) {
                nextUser.id = authResult.user.id;
                nextUser.username = authResult.user.global_name || authResult.user.username;
                nextUser.avatarUrl = buildDiscordAvatarUrl(authResult.user.id, authResult.user.avatar);
              }
            } catch (authError) {
              // FORCES THE ERROR TO SHOW ON YOUR SCREEN
              setErrorMessage(`Auth Error: ${authError instanceof Error ? authError.message : JSON.stringify(authError)}`);
              console.error("Discord Auth fully failed:", authError);
            }

          } catch (error) {
            // eslint-disable-next-line no-console
            console.error("Discord SDK init failed", error);
            setErrorMessage(
              "Discord SDK init failed. Running in local fallback mode.",
            );
          }
        }

        try {
          patchDiscordNetworkMappings(BACKEND_BASE_URL);
        } catch {
          setErrorMessage(
            "URL mapping patch failed; check NEXT_PUBLIC_URL_MAPPING_PREFIX.",
          );
        }
      }

      if (cancelled) {
        return;
      }

      if (!inDiscordActivity) {
        setRuntimeLabel("local");
        setUrlUserId(explicitUrlUserId);
      }
      setUseDiscordProxy(inDiscordActivity);
      setRoomId(nextRoomId);
      setMe(nextUser);

      const parsedBackendUrl = new URL(BACKEND_BASE_URL);
      const backendPathPrefix =
        parsedBackendUrl.pathname === "/"
          ? ""
          : trimTrailingSlash(parsedBackendUrl.pathname);
      const socketBase = inDiscordActivity
        ? window.location.origin
        : parsedBackendUrl.origin;
      const socketPath = `${
        inDiscordActivity ? trimTrailingSlash(URL_MAPPING_PREFIX) : backendPathPrefix
      }/socket.io`;

      const socket = io(socketBase, {
        path: socketPath,
        transports: ["websocket", "polling"],
      });
      socketRef.current = socket;

      socket.on("connect", () => {
        setIsConnected(true);
        setErrorMessage(null);
        socket.emit("join_room", {
          roomId: nextRoomId,
          user: nextUser,
        });
      });

      socket.on("disconnect", () => {
        setIsConnected(false);
      });

      socket.on("room_state", (nextState: RoomStateView) => {
        setRoomState(nextState);
      });

      socket.on("countdown_tick", (payload: { secondsLeft: number }) => {
        setCountdown(payload.secondsLeft);
      });

      socket.on("results_timeline", (timeline: ResultsTimeline) => {
        setResultsTimeline(timeline);
      });

      socket.on("error_message", (payload: { message?: string }) => {
        setErrorMessage(payload.message || "Unknown socket error.");
      });
    }

    void bootstrap();

    return () => {
      cancelled = true;
      if (socketRef.current) {
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (roomState.phase !== PHASES.VOTING) {
      setHasVoted(false);
    }
    if (roomState.phase !== PHASES.GIF_SEARCH) {
      setSelectedGif(null);
      setSearchCursor(null);
      setSearchResults([]);
    }
    if (roomState.phase !== PHASES.ROUND_RESULTS) {
      setResultsTimeline(null);
      setRevealedRanks([]);
    }
  }, [roomState.phase]);

  useEffect(() => {
    if (!resultsTimeline) {
      return;
    }
    setRevealedRanks([]);
    const timeoutIds = resultsTimeline.revealSchedule.map((step) =>
      window.setTimeout(() => {
        setRevealedRanks((prev) =>
          prev.includes(step.rank) ? prev : [...prev, step.rank],
        );
      }, step.revealAtMs),
    );
    return () => {
      for (const id of timeoutIds) {
        window.clearTimeout(id);
      }
    };
  }, [resultsTimeline]);

  const searchKlipy = useCallback(
    async (append: boolean) => {
      const q = searchTerm.trim();
      if (!q || roomState.phase !== PHASES.GIF_SEARCH) {
        return;
      }

      setSearching(true);
      setErrorMessage(null);
      try {
        const params = new URLSearchParams({
          q,
          limit: "20",
          locale: language === "ar" ? "ar_SA" : "en_US",
          contentfilter: "medium",
          media_filter: "gif,mediumgif",
        });
        if (append && searchCursor) {
          params.set("pos", searchCursor);
        }

        const response = await fetch(
          `${backendApiBase}/api/klipy/search?${params.toString()}`,
        );
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error?.message || "Klipy search failed.");
        }

        const nextResults: GifAsset[] = payload.results || [];
        setSearchResults((previous) => {
          if (!append) {
            return nextResults;
          }
          const merged = [...previous];
          for (const item of nextResults) {
            if (!merged.some((existing) => existing.id === item.id)) {
              merged.push(item);
            }
          }
          return merged;
        });
        setSearchCursor(payload.next || null);
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : "GIF search failed.",
        );
      } finally {
        setSearching(false);
      }
    },
    [backendApiBase, language, roomState.phase, searchCursor, searchTerm],
  );

  const visiblePodium = useMemo(() => {
    const source = resultsTimeline?.podium || roomState.rankedResults || [];
    const byRank = new Map<number, PodiumEntry>();
    for (const entry of source) {
      byRank.set(entry.rank, entry);
    }
    return byRank;
  }, [resultsTimeline, roomState.rankedResults]);

  const currentPromptText = useMemo(() => {
    const prompt = roomState.currentPrompt;
    if (!prompt) {
      return dict.noPrompt;
    }
    return language === "ar" ? prompt.ar : prompt.en;
  }, [dict.noPrompt, language, roomState.currentPrompt]);

  const resultsPromptText = useMemo(() => {
    const prompt = resultsTimeline?.prompt || roomState.currentPrompt;
    if (!prompt) {
      return dict.noPrompt;
    }
    return language === "ar" ? prompt.ar : prompt.en;
  }, [dict.noPrompt, language, resultsTimeline?.prompt, roomState.currentPrompt]);

  function emitDeckModeChange(nextDeckMode: DeckMode) {
    socketRef.current?.emit("admin_set_deck_mode", {
      roomId,
      deckMode: nextDeckMode,
    });
  }

  function emitMinPlayersChange(nextMinPlayers: number) {
    socketRef.current?.emit("admin_set_min_players", {
      roomId,
      minPlayers: nextMinPlayers,
    });
  }

  function emitAddCustomPrompt() {
    const en = customPromptEn.trim();
    const ar = customPromptAr.trim();
    if (!en || !ar) {
      setErrorMessage("Both EN and AR custom prompts are required.");
      return;
    }
    socketRef.current?.emit("add_custom_prompt", {
      roomId,
      en,
      ar,
    });
    setCustomPromptEn("");
    setCustomPromptAr("");
  }

  function emitStartRound() {
    socketRef.current?.emit("admin_start_round", { roomId });
  }

  function emitSubmitGif() {
    if (!selectedGif) {
      return;
    }
    setSubmittingGif(true);
    socketRef.current?.emit("submit_gif", {
      roomId,
      gif: selectedGif,
    });
    window.setTimeout(() => setSubmittingGif(false), 350);
  }

  function emitVote(targetPlayerId: string) {
    if (hasVoted || targetPlayerId === me.id) {
      return;
    }
    setHasVoted(true);
    socketRef.current?.emit("cast_vote", {
      roomId,
      targetPlayerId,
    });
  }

  return (
    <main dir={dir} className="relative mx-auto min-h-screen max-w-7xl p-4 md:p-8">
      <div className="neon-card rounded-2xl p-4 md:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-wide text-cyan-200 md:text-3xl">
              {dict.title}
            </h1>
            <p className="text-sm text-slate-300">{dict.subtitle}</p>
          </div>

          <div className="ms-auto flex items-center gap-2">
            <span className="text-xs text-slate-300">{dict.languageLabel}</span>
            <button
              type="button"
              className={`neon-btn rounded-lg px-3 py-1.5 text-xs ${
                language === "en" ? "shadow-glowBlue" : ""
              }`}
              onClick={() => setLanguage("en")}
            >
              EN
            </button>
            <button
              type="button"
              className={`neon-btn rounded-lg px-3 py-1.5 text-xs ${
                language === "ar" ? "shadow-glowPurple" : ""
              }`}
              onClick={() => setLanguage("ar")}
            >
              AR
            </button>
          </div>
        </header>

        <section className="mt-4 grid gap-4 lg:grid-cols-[1.8fr_1fr]">
          <div className="space-y-4">
            <div className="neon-card rounded-xl px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
                <span>
                  {dict.room}:{" "}
                  <span className="font-semibold text-slate-100">{roomId}</span>
                </span>
                <span>
                  {activePhaseLabel}{" "}
                  {countdown !== null ? (
                    <strong className="ms-1 text-cyan-200">{countdown}s</strong>
                  ) : null}
                </span>
                <span
                  className={isConnected ? "text-emerald-300" : "text-rose-300"}
                >
                  {isConnected ? dict.connected : dict.disconnected}
                </span>
              </div>
            </div>

            <AnimatePresence mode="wait">
              {roomState.phase === PHASES.LOBBY ? (
                <motion.section
                  key="lobby"
                  initial={{ opacity: 0, y: 18, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -16 }}
                  transition={{ duration: 0.28 }}
                  className="neon-card rounded-xl p-4"
                >
                  <h2 className="text-lg font-semibold text-cyan-200">{dict.lobby}</h2>
                  <p className="mt-1 text-xs text-slate-300">{dict.onlyAdmin}</p>

                  {isAdmin ? (
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <label className="text-xs text-slate-200">
                        {dict.deckMode}
                        <select
                          className="mt-1 w-full rounded-lg border border-cyan-500/30 bg-slate-950/70 p-2 text-sm"
                          value={roomState.deckMode}
                          onChange={(event) =>
                            emitDeckModeChange(event.target.value as DeckMode)
                          }
                        >
                          <option value="DEFAULT">DEFAULT</option>
                          <option value="CUSTOM">CUSTOM</option>
                          <option value="MIXED">MIXED</option>
                        </select>
                      </label>

                      <label className="text-xs text-slate-200">
                        {dict.minPlayers}
                        <select
                          className="mt-1 w-full rounded-lg border border-cyan-500/30 bg-slate-950/70 p-2 text-sm"
                          value={roomState.minPlayers}
                          onChange={(event) =>
                            emitMinPlayersChange(Number(event.target.value))
                          }
                        >
                          <option value={1}>1</option>
                          <option value={2}>2</option>
                          <option value={3}>3</option>
                        </select>
                      </label>

                      <label className="text-xs text-slate-200">
                        {dict.enPrompt}
                        <input
                          className="mt-1 w-full rounded-lg border border-purple-400/40 bg-slate-950/70 p-2 text-sm"
                          value={customPromptEn}
                          onChange={(event) => setCustomPromptEn(event.target.value)}
                          placeholder="When your mic is muted..."
                        />
                      </label>

                      <label className="text-xs text-slate-200">
                        {dict.arPrompt}
                        <input
                          className="mt-1 w-full rounded-lg border border-purple-400/40 bg-slate-950/70 p-2 text-sm"
                          value={customPromptAr}
                          onChange={(event) => setCustomPromptAr(event.target.value)}
                          placeholder="لما يكون المايك مقفل..."
                        />
                      </label>

                      <button
                        type="button"
                        className="neon-btn rounded-lg p-2 text-sm"
                        onClick={emitAddCustomPrompt}
                      >
                        {dict.submitPrompt}
                      </button>
                      <button
                        type="button"
                        className="neon-btn rounded-lg p-2 text-sm"
                        onClick={emitStartRound}
                        disabled={!roomState.canStartRound}
                      >
                        {dict.startRound}
                      </button>
                    </div>
                  ) : null}
                </motion.section>
              ) : null}

              {roomState.phase === PHASES.PROMPT_REVEAL ? (
                <motion.section
                  key="prompt"
                  initial={{ opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ type: "spring", stiffness: 120, damping: 16 }}
                  className="neon-card rounded-xl p-6 text-center"
                >
                  <h2 className="text-sm uppercase tracking-[0.22em] text-fuchsia-300">
                    {dict.promptReveal}
                  </h2>
                  <p className="mt-4 text-xl font-semibold text-cyan-100 md:text-3xl">
                    {currentPromptText}
                  </p>
                </motion.section>
              ) : null}

              {roomState.phase === PHASES.GIF_SEARCH ? (
                <motion.section
                  key="search"
                  initial={{ opacity: 0, y: 18 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -14 }}
                  className="neon-card rounded-xl p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-lg font-semibold text-cyan-200">
                      {dict.searchGifs}
                    </h2>
                    <button
                      type="button"
                      className="neon-btn rounded-lg px-3 py-1 text-xs"
                      onClick={() => setSearchOpen((prev) => !prev)}
                    >
                      {dict.search}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-slate-300">{dict.searchHint}</p>

                  <motion.div
                    initial={false}
                    animate={{
                      opacity: searchOpen ? 1 : 0,
                      height: searchOpen ? "auto" : 0,
                    }}
                    className="overflow-hidden"
                  >
                    <div className="mt-3 flex gap-2">
                      <input
                        className="min-w-0 flex-1 rounded-lg border border-cyan-400/40 bg-slate-950/70 px-3 py-2 text-sm"
                        placeholder={dict.searchPlaceholder}
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            void searchKlipy(false);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="neon-btn rounded-lg px-3 py-2 text-sm"
                        onClick={() => void searchKlipy(false)}
                        disabled={searching}
                      >
                        {searching ? dict.searching : dict.search}
                      </button>
                    </div>
                  </motion.div>

                  <motion.div
                    layout
                    className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4"
                  >
                    <AnimatePresence>
                      {searchResults.map((gif) => (
                        <motion.button
                          layout
                          type="button"
                          key={gif.id}
                          initial={{ opacity: 0, y: 20, scale: 0.92 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          transition={{ duration: 0.18 }}
                          onClick={() => setSelectedGif(gif)}
                          className={`overflow-hidden rounded-lg border ${
                            selectedGif?.id === gif.id
                              ? "border-cyan-300 shadow-glowBlue"
                              : "border-white/15"
                          }`}
                        >
                          <img
                            src={gif.previewUrl || gif.url}
                            alt={gif.title || "GIF"}
                            className="h-28 w-full object-cover md:h-32"
                          />
                        </motion.button>
                      ))}
                    </AnimatePresence>
                  </motion.div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="neon-btn rounded-lg px-4 py-2 text-sm"
                      disabled={!selectedGif || submittingGif}
                      onClick={emitSubmitGif}
                    >
                      {submittingGif ? dict.submitting : dict.submitGif}
                    </button>
                    <button
                      type="button"
                      className="neon-btn rounded-lg px-4 py-2 text-sm"
                      disabled={!searchCursor || searching}
                      onClick={() => void searchKlipy(true)}
                    >
                      {dict.loadMore}
                    </button>
                  </div>
                </motion.section>
              ) : null}

              {roomState.phase === PHASES.VOTING ? (
                <motion.section
                  key="voting"
                  initial={{ opacity: 0, y: 18 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -14 }}
                  className="neon-card rounded-xl p-4"
                >
                  <h2 className="text-lg font-semibold text-cyan-200">
                    {dict.voting}
                  </h2>
                  <p className="mt-1 text-xs text-slate-300">{dict.voteHint}</p>

                  <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
                    {roomState.voteOptions.map((option) => (
                      <motion.button
                        type="button"
                        key={`${option.targetPlayerId}-${option.gif.id}`}
                        whileHover={{ y: -2 }}
                        className="overflow-hidden rounded-lg border border-white/15"
                        disabled={hasVoted || option.targetPlayerId === me.id}
                        onClick={() => emitVote(option.targetPlayerId)}
                      >
                        <img
                          src={option.gif.previewUrl || option.gif.url}
                          alt={option.gif.title || "Vote option"}
                          className="h-28 w-full object-cover md:h-36"
                        />
                        <div className="p-2 text-xs text-slate-200">
                          {hasVoted ? dict.waitingVotes : dict.voteNow}
                        </div>
                      </motion.button>
                    ))}
                  </div>
                </motion.section>
              ) : null}

              {roomState.phase === PHASES.ROUND_RESULTS ? (
                <motion.section
                  key="results"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -12 }}
                  className="neon-card rounded-xl p-4"
                >
                  <h2 className="text-lg font-semibold text-cyan-200">
                    {dict.results}
                  </h2>
                  <p className="mt-1 text-xs text-slate-300">{dict.resultsHint}</p>
                  <div className="mt-3 rounded-lg border border-fuchsia-400/30 bg-fuchsia-500/10 p-3 text-center text-sm text-fuchsia-100">
                    {resultsPromptText}
                  </div>

                  <div className="mt-5 flex items-end justify-center gap-3 md:gap-5">
                    {[3, 2, 1].map((rank) => {
                      const entry = visiblePodium.get(rank);
                      const isVisible = entry ? revealedRanks.includes(rank) : false;
                      const podiumHeight =
                        rank === 1 ? "h-64 md:h-72" : rank === 2 ? "h-52 md:h-60" : "h-40 md:h-48";

                      return (
                        <motion.div
                          key={`podium-${rank}`}
                          initial={false}
                          animate={{
                            opacity: isVisible ? 1 : 0.35,
                            y: isVisible ? 0 : 18,
                            scale: isVisible ? 1 : 0.97,
                          }}
                          className={`podium-step relative w-[31%] min-w-[90px] rounded-xl px-2 pb-2 pt-3 ${podiumHeight}`}
                        >
                          <div className="text-center text-xs font-semibold text-slate-200">
                            #{rank}
                          </div>

                          {entry ? (
                            <div className="mt-2 flex h-full flex-col">
                              <div className="relative overflow-hidden rounded-md border border-white/20">
                                {entry.isFirst && isVisible ? (
                                  <span className="absolute start-2 top-1 z-10 rounded bg-amber-300/90 px-1.5 text-xs text-black">
                                    👑
                                  </span>
                                ) : null}
                                <img
                                  src={entry.gif.previewUrl || entry.gif.url}
                                  alt={entry.gif.title || "Podium GIF"}
                                  className="h-20 w-full object-cover md:h-24"
                                />
                              </div>

                              <div className="mt-2 text-center text-xs text-slate-100 md:text-sm">
                                {entry.isFirst ? `👑 ${entry.username}` : entry.username}
                              </div>

                              <motion.div
                                initial={{ width: 0 }}
                                animate={{
                                  width: isVisible
                                    ? `${Math.min(100, 16 + entry.votes * 24)}%`
                                    : "0%",
                                }}
                                className="mx-auto mt-2 h-1.5 rounded-full bg-cyan-300"
                              />
                              <div className="mt-1 text-center text-xs text-slate-300">
                                {dict.voteCount}: {entry.votes}
                              </div>
                            </div>
                          ) : (
                            <div className="mt-4 text-center text-xs text-slate-500">-</div>
                          )}
                        </motion.div>
                      );
                    })}
                  </div>
                </motion.section>
              ) : null}
            </AnimatePresence>

            {errorMessage ? (
              <div className="rounded-lg border border-rose-500/50 bg-rose-500/20 p-3 text-sm text-rose-100">
                {errorMessage}
              </div>
            ) : null}
          </div>

          <aside className="space-y-4">
            <section className="neon-card rounded-xl p-4">
              <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-200">
                {dict.scoreboard}
              </h3>
              <div className="mt-3 space-y-2">
                {roomState.players.map((player) => (
                  <div
                    key={player.id}
                    className="flex items-center justify-between rounded-lg border border-white/10 bg-slate-900/45 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      {player.avatarUrl ? (
                        <img
                          src={player.avatarUrl}
                          alt={player.username}
                          className="h-8 w-8 rounded-full object-cover"
                        />
                      ) : (
                        <div className="h-8 w-8 rounded-full bg-slate-700/70" />
                      )}
                      <div className="text-sm text-slate-100">
                        {player.id === ADMIN_DISCORD_ID ? "👑 " : ""}
                        {player.username}
                      </div>
                    </div>
                    <div className="text-sm font-semibold text-cyan-200">{player.score}</div>
                  </div>
                ))}
                {!roomState.players.length ? (
                  <div className="text-xs text-slate-400">{dict.players}: 0</div>
                ) : null}
              </div>
            </section>

            <section className="neon-card rounded-xl p-4">
              <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-200">
                {dict.players}
              </h3>
              <div className="mt-2 text-sm text-slate-200">
                {roomState.players.length}
              </div>
              <div className="mt-2 text-xs text-slate-300">
                {dict.customCount}: {roomState.customPromptCount}
              </div>
              <div className="mt-2 text-xs text-slate-300">
                {dict.deckMode}: {roomState.deckMode}
              </div>
              <div className="mt-2 text-xs text-slate-300">
                {dict.minPlayers}: {roomState.minPlayers}
              </div>
              <div className="mt-2 text-xs text-slate-300">
                {dict.voteCount}: {roomState.votesCount}
              </div>
              <div className="mt-2 break-all text-[11px] text-slate-400">
                My ID: {me.id}
              </div>
              <div className="mt-1 break-all text-[11px] text-slate-500">
                URL User ID: {urlUserId || "none"}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                Runtime: {runtimeLabel}
              </div>
            </section>
          </aside>
        </section>
      </div>
    </main>
  );
}
