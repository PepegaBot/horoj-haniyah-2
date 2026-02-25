const http = require("http");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { Server } = require("socket.io");

dotenv.config();

const ADMIN_DISCORD_ID = "217998454197190656";

const PHASES = {
  LOBBY: "LOBBY",
  PROMPT_REVEAL: "PROMPT_REVEAL",
  GIF_SEARCH: "GIF_SEARCH",
  VOTING: "VOTING",
  ROUND_RESULTS: "ROUND_RESULTS",
};

const DECK_MODES = {
  DEFAULT: "DEFAULT",
  CUSTOM: "CUSTOM",
  MIXED: "MIXED",
};

const PROMPT_REVEAL_SECONDS = 4;
const GIF_SEARCH_SECONDS = 45;
const VOTING_SECONDS = 20;
const ROUND_RESULTS_SECONDS = 12;
const MAX_KLIPY_LIMIT = 50;
const DEFAULT_KLIPY_LIMIT = 20;

const DEFAULT_PROMPTS = [
  {
    id: "default_1",
    source: "default",
    en: "When you accidentally open the front camera",
    ar: "شكلك لما تفتح الكاميرا الأمامية بالغلط",
  },
  {
    id: "default_2",
    source: "default",
    en: "When the Wi-Fi dies during the boss fight",
    ar: "لما الواي فاي يفصل وقت معركة الزعيم",
  },
  {
    id: "default_3",
    source: "default",
    en: "When your mom asks who ate the last slice",
    ar: "لما أمك تسأل مين أكل آخر قطعة",
  },
  {
    id: "default_4",
    source: "default",
    en: "POV: You said one quick game at 2 AM",
    ar: "منظورك لما تقول جيم سريع الساعة ٢ الفجر",
  },
  {
    id: "default_5",
    source: "default",
    en: "When the group project has one hard-carry",
    ar: "لما مشروع المجموعة كله على شخص واحد",
  },
  {
    id: "default_6",
    source: "default",
    en: "When your alarm rings after 3 hours of sleep",
    ar: "لما المنبه يرن بعد ٣ ساعات نوم",
  },
  {
    id: "default_7",
    source: "default",
    en: "When you send a risky message then see 'typing...'",
    ar: "لما ترسل رسالة خطيرة وبعدين تشوف 'يكتب...' ",
  },
  {
    id: "default_8",
    source: "default",
    en: "When you realize the exam is today, not tomorrow",
    ar: "لما تكتشف الاختبار اليوم مو بكرة",
  },
  {
    id: "default_9",
    source: "default",
    en: "How you enter the chat after 200 unread messages",
    ar: "كيف تدخل الشات بعد ٢٠٠ رسالة غير مقروءة",
  },
  {
    id: "default_10",
    source: "default",
    en: "When the teacher says 'this is easy'",
    ar: "لما المدرس يقول 'هذا سهل'",
  },
];

function createId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function getAdminOverrideIds() {
  return String(process.env.ADMIN_OVERRIDE_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isAdminUser(userId) {
  const normalizedUserId = String(userId);
  if (normalizedUserId === ADMIN_DISCORD_ID) {
    return true;
  }
  return getAdminOverrideIds().includes(normalizedUserId);
}

function isRoomAdmin(room, userId) {
  const normalizedUserId = String(userId);
  return room.adminId === normalizedUserId || isAdminUser(normalizedUserId);
}

function clampMinPlayers(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 3;
  }
  return Math.max(1, Math.min(3, Math.floor(parsed)));
}

function normalizeDeckMode(deckMode) {
  if (
    deckMode === DECK_MODES.DEFAULT ||
    deckMode === DECK_MODES.CUSTOM ||
    deckMode === DECK_MODES.MIXED
  ) {
    return deckMode;
  }
  return DECK_MODES.DEFAULT;
}

function makePlayerFromPayload(userPayload) {
  return {
    id: String(userPayload.id),
    username: String(userPayload.username || "Player"),
    avatarUrl: userPayload.avatarUrl ? String(userPayload.avatarUrl) : null,
    connectedAt: Date.now(),
  };
}

function createRoom(roomId) {
  return {
    roomId,
    adminId: null,
    phase: PHASES.LOBBY,
    phaseEndsAt: null,
    deckMode: DECK_MODES.DEFAULT,
    minPlayers: 3,
    defaultPrompts: [...DEFAULT_PROMPTS],
    customPrompts: [],
    currentPrompt: null,
    players: new Map(), // socketId -> player
    submissions: new Map(), // playerId -> submission
    votes: new Map(), // voterId -> targetPlayerId
    voteOptions: [], // [{targetPlayerId, gif}]
    scores: new Map(), // playerId -> points
    roundParticipantIds: new Set(),
    rankedResults: [],
    roundNumber: 0,
    phaseTimer: null,
    tickTimer: null,
  };
}

function getOrCreateRoom(rooms, roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, createRoom(roomId));
  }
  return rooms.get(roomId);
}

function clearRoomTimers(room) {
  if (room.phaseTimer) {
    clearTimeout(room.phaseTimer);
    room.phaseTimer = null;
  }
  if (room.tickTimer) {
    clearInterval(room.tickTimer);
    room.tickTimer = null;
  }
}

function getConnectedPlayers(room) {
  return Array.from(room.players.values());
}

function getConnectedPlayerIds(room) {
  return new Set(getConnectedPlayers(room).map((player) => player.id));
}

function getActiveRoundParticipantIds(room) {
  const connectedPlayerIds = getConnectedPlayerIds(room);
  return Array.from(room.roundParticipantIds).filter((id) =>
    connectedPlayerIds.has(id),
  );
}

function canStartRound(room) {
  return getConnectedPlayers(room).length >= room.minPlayers;
}

function sanitizeRoomState(room) {
  const players = getConnectedPlayers(room)
    .map((player) => ({
      id: player.id,
      username: player.username,
      avatarUrl: player.avatarUrl,
      isAdmin: isRoomAdmin(room, player.id),
      score: room.scores.get(player.id) || 0,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.username.localeCompare(b.username);
    });

  return {
    roomId: room.roomId,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    roundNumber: room.roundNumber,
    deckMode: room.deckMode,
    minPlayers: room.minPlayers,
    canStartRound: canStartRound(room),
    currentPrompt: room.currentPrompt,
    customPromptCount: room.customPrompts.length,
    players,
    submissionsCount: room.submissions.size,
    votesCount: room.votes.size,
    voteOptions: room.phase === PHASES.VOTING ? room.voteOptions : [],
    rankedResults:
      room.phase === PHASES.ROUND_RESULTS ? room.rankedResults : [],
  };
}

function emitRoomState(io, room) {
  io.to(room.roomId).emit("room_state", sanitizeRoomState(room));
}

function emitError(socket, code, message) {
  socket.emit("error_message", { code, message });
}

function shuffleInPlace(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getPromptPool(room) {
  if (room.deckMode === DECK_MODES.DEFAULT) {
    return room.defaultPrompts;
  }
  if (room.deckMode === DECK_MODES.CUSTOM) {
    if (room.customPrompts.length > 0) {
      return room.customPrompts;
    }
    return room.defaultPrompts;
  }
  return [...room.defaultPrompts, ...room.customPrompts];
}

function selectPrompt(room) {
  const pool = getPromptPool(room);
  if (!pool.length) {
    return null;
  }
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

function buildPodium(room) {
  const voteCounts = new Map();
  const entries = [];

  for (const [playerId, submission] of room.submissions.entries()) {
    voteCounts.set(playerId, 0);
    entries.push({
      playerId,
      gif: submission.gif,
      submittedAt: submission.submittedAt,
    });
  }

  for (const [, targetPlayerId] of room.votes.entries()) {
    if (voteCounts.has(targetPlayerId)) {
      voteCounts.set(targetPlayerId, voteCounts.get(targetPlayerId) + 1);
    }
  }

  for (const [playerId, votes] of voteCounts.entries()) {
    room.scores.set(playerId, (room.scores.get(playerId) || 0) + votes);
  }

  const playersById = new Map(
    getConnectedPlayers(room).map((player) => [player.id, player]),
  );

  const ranked = entries
    .map((entry) => ({
      ...entry,
      votes: voteCounts.get(entry.playerId) || 0,
      username:
        playersById.get(entry.playerId)?.username ||
        `Player ${entry.playerId.slice(-4)}`,
    }))
    .sort((a, b) => {
      if (b.votes !== a.votes) {
        return b.votes - a.votes;
      }
      return a.submittedAt - b.submittedAt;
    })
    .slice(0, 3)
    .map((entry, index) => ({
      rank: index + 1,
      playerId: entry.playerId,
      username: entry.username,
      votes: entry.votes,
      gif: entry.gif,
      isFirst: index === 0,
    }));

  return ranked;
}

function buildRevealSchedule(podium) {
  const revealOrder = [...podium].sort((a, b) => b.rank - a.rank);
  return revealOrder.map((entry, index) => ({
    rank: entry.rank,
    revealAtMs: index * 2200,
  }));
}

function startPhase(io, room, phase, durationSeconds, onComplete) {
  clearRoomTimers(room);
  room.phase = phase;
  room.phaseEndsAt =
    durationSeconds > 0 ? Date.now() + durationSeconds * 1000 : null;

  io.to(room.roomId).emit("phase_changed", {
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    roundNumber: room.roundNumber,
  });
  emitRoomState(io, room);

  if (durationSeconds > 0) {
    room.tickTimer = setInterval(() => {
      const msLeft = Math.max(0, room.phaseEndsAt - Date.now());
      const secondsLeft = Math.ceil(msLeft / 1000);
      io.to(room.roomId).emit("countdown_tick", {
        phase: room.phase,
        secondsLeft,
      });
      if (secondsLeft <= 0) {
        clearRoomTimers(room);
      }
    }, 1000);

    room.phaseTimer = setTimeout(() => {
      clearRoomTimers(room);
      if (typeof onComplete === "function") {
        onComplete();
      }
    }, durationSeconds * 1000);
  }
}

function transitionToLobby(io, room) {
  room.currentPrompt = null;
  room.submissions = new Map();
  room.votes = new Map();
  room.voteOptions = [];
  room.roundParticipantIds = new Set();
  room.rankedResults = [];
  startPhase(io, room, PHASES.LOBBY, 0);
}

function transitionToRoundResults(io, room) {
  room.rankedResults = buildPodium(room);

  startPhase(io, room, PHASES.ROUND_RESULTS, ROUND_RESULTS_SECONDS, () => {
    transitionToLobby(io, room);
  });

  const revealSchedule = buildRevealSchedule(room.rankedResults);
  io.to(room.roomId).emit("results_timeline", {
    prompt: room.currentPrompt,
    podium: room.rankedResults,
    revealSchedule,
    phaseEndsAt: room.phaseEndsAt,
  });

  if (room.rankedResults[0]) {
    io.to(room.roomId).emit("round_winner", {
      playerId: room.rankedResults[0].playerId,
      votes: room.rankedResults[0].votes,
      awardedPoints: room.rankedResults[0].votes,
    });
  }

  emitRoomState(io, room);
}

function makeVotingOptions(room) {
  const participantIds = getActiveRoundParticipantIds(room);
  const options = participantIds
    .map((participantId) => room.submissions.get(participantId))
    .filter(Boolean)
    .map((submission) => ({
      targetPlayerId: submission.playerId,
      gif: submission.gif,
    }));
  return shuffleInPlace(options);
}

function transitionToVoting(io, room) {
  if (room.phase !== PHASES.GIF_SEARCH && room.phase !== PHASES.PROMPT_REVEAL) {
    return;
  }
  room.voteOptions = makeVotingOptions(room);

  if (!room.voteOptions.length) {
    transitionToRoundResults(io, room);
    return;
  }

  startPhase(io, room, PHASES.VOTING, VOTING_SECONDS, () => {
    transitionToRoundResults(io, room);
  });
}

function allRoundParticipantsSubmitted(room) {
  const participantIds = getActiveRoundParticipantIds(room);
  if (!participantIds.length) {
    return false;
  }
  return participantIds.every((playerId) => room.submissions.has(playerId));
}

function allEligibleVotesCast(room) {
  const voterIds = getActiveRoundParticipantIds(room).filter((playerId) =>
    room.submissions.has(playerId),
  );
  if (!voterIds.length) {
    return false;
  }
  return voterIds.every((voterId) => room.votes.has(voterId));
}

function transitionToGifSearch(io, room) {
  if (room.phase !== PHASES.PROMPT_REVEAL) {
    return;
  }
  startPhase(io, room, PHASES.GIF_SEARCH, GIF_SEARCH_SECONDS, () => {
    transitionToVoting(io, room);
  });
}

function startRound(io, room) {
  if (room.phase !== PHASES.LOBBY) {
    return {
      ok: false,
      code: "ROUND_NOT_IN_LOBBY",
      message: "Round can only be started from the lobby.",
    };
  }

  if (!canStartRound(room)) {
    return {
      ok: false,
      code: "NOT_ENOUGH_PLAYERS",
      message: `Need at least ${room.minPlayers} player(s) to start.`,
    };
  }

  room.roundNumber += 1;
  room.submissions = new Map();
  room.votes = new Map();
  room.voteOptions = [];
  room.rankedResults = [];
  room.roundParticipantIds = new Set(getConnectedPlayers(room).map((p) => p.id));
  room.currentPrompt = selectPrompt(room);

  startPhase(io, room, PHASES.PROMPT_REVEAL, PROMPT_REVEAL_SECONDS, () => {
    transitionToGifSearch(io, room);
  });

  io.to(room.roomId).emit("round_prompt", room.currentPrompt);
  emitRoomState(io, room);

  return { ok: true };
}

function normalizeKlipyResult(item) {
  const gifFormat = item?.media_formats?.gif;
  const mediumGifFormat = item?.media_formats?.mediumgif;
  const url = gifFormat?.url || mediumGifFormat?.url || null;

  if (!url) {
    return null;
  }

  return {
    id: String(item.id),
    title: String(item.title || ""),
    url,
    previewUrl:
      gifFormat?.preview || mediumGifFormat?.preview || gifFormat?.url || url,
  };
}

function createApp({ fetchImpl = fetch } = {}) {
  const app = express();
  const corsOrigin = process.env.CORS_ORIGIN || "*";

  app.use(
    cors({
      origin: corsOrigin === "*" ? true : corsOrigin.split(","),
      credentials: true,
    }),
  );
  app.use(express.json());

  app.get("/health", (_, res) => {
    res.json({ ok: true, service: "horoj-haniya-backend" });
  });

  app.get("/api/klipy/search", async (req, res) => {
    try {
      const query = String(req.query.q || "").trim();
      if (!query) {
        return res.status(400).json({
          error: { code: "MISSING_QUERY", message: "Query parameter q is required." },
        });
      }

      if (!process.env.KLIPY_API_KEY) {
        return res.status(500).json({
          error: {
            code: "KLIPY_KEY_MISSING",
            message: "KLIPY_API_KEY is missing on the server.",
          },
        });
      }

      const limitRaw = Number(req.query.limit || DEFAULT_KLIPY_LIMIT);
      const limit = Math.max(1, Math.min(MAX_KLIPY_LIMIT, Math.floor(limitRaw)));
      const params = new URLSearchParams({
        key: process.env.KLIPY_API_KEY,
        q: query,
        limit: String(limit),
      });

      const optionalFields = [
        "pos",
        "locale",
        "contentfilter",
        "media_filter",
        "searchfilter",
      ];
      for (const key of optionalFields) {
        const value = req.query[key];
        if (typeof value === "string" && value.trim().length > 0) {
          params.set(key, value.trim());
        }
      }

      const upstreamRes = await fetchImpl(
        `https://api.klipy.com/v2/search?${params.toString()}`,
      );

      const body = await upstreamRes.json().catch(() => ({}));

      if (!upstreamRes.ok) {
        return res.status(upstreamRes.status).json({
          error: {
            code: "KLIPY_UPSTREAM_ERROR",
            message: "Klipy API request failed.",
            details: body,
          },
        });
      }

      const normalized = Array.isArray(body.results)
        ? body.results.map(normalizeKlipyResult).filter(Boolean)
        : [];

      return res.json({
        results: normalized,
        next: body.next ?? null,
      });
    } catch (error) {
      return res.status(502).json({
        error: {
          code: "KLIPY_PROXY_FAILURE",
          message: "Could not fetch GIFs from Klipy.",
          details: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  return app;
}

function registerSocketHandlers(io, rooms) {
  io.on("connection", (socket) => {
    socket.on("join_room", (payload) => {
      try {
        const roomId = String(payload?.roomId || "").trim();
        const user = payload?.user;

        if (!roomId) {
          emitError(socket, "INVALID_ROOM_ID", "roomId is required.");
          return;
        }
        if (!user?.id || !user?.username) {
          emitError(socket, "INVALID_USER", "user.id and user.username are required.");
          return;
        }

        const room = getOrCreateRoom(rooms, roomId);
        const player = makePlayerFromPayload(user);

        // Keep one active socket per player ID.
        for (const [existingSocketId, existingPlayer] of room.players.entries()) {
          if (existingPlayer.id === player.id && existingSocketId !== socket.id) {
            room.players.delete(existingSocketId);
            const oldSocket = io.sockets.sockets.get(existingSocketId);
            if (oldSocket) {
              oldSocket.leave(roomId);
            }
          }
        }

        room.players.set(socket.id, player);
        if (!room.scores.has(player.id)) {
          room.scores.set(player.id, 0);
        }

        if (!room.adminId) {
          room.adminId = player.id;
        }

        socket.data.roomId = roomId;
        socket.data.playerId = player.id;
        socket.join(roomId);
        emitRoomState(io, room);
      } catch (error) {
        emitError(
          socket,
          "JOIN_FAILED",
          error instanceof Error ? error.message : "Could not join room.",
        );
      }
    });

    socket.on("admin_set_deck_mode", (payload) => {
      const roomId = String(payload?.roomId || socket.data.roomId || "");
      const room = rooms.get(roomId);
      const playerId = String(socket.data.playerId || "");
      if (!room) {
        emitError(socket, "ROOM_NOT_FOUND", "Room does not exist.");
        return;
      }
      if (!isAdminUser(playerId)) {
        emitError(socket, "FORBIDDEN", "Only the admin can change deck mode.");
        return;
      }

      room.deckMode = normalizeDeckMode(payload?.deckMode);
      emitRoomState(io, room);
    });

    socket.on("admin_set_min_players", (payload) => {
      const roomId = String(payload?.roomId || socket.data.roomId || "");
      const room = rooms.get(roomId);
      const playerId = String(socket.data.playerId || "");
      if (!room) {
        emitError(socket, "ROOM_NOT_FOUND", "Room does not exist.");
        return;
      }
      if (!isAdminUser(playerId)) {
        emitError(socket, "FORBIDDEN", "Only the admin can set minimum players.");
        return;
      }

      room.minPlayers = clampMinPlayers(payload?.minPlayers);
      emitRoomState(io, room);
    });

    socket.on("add_custom_prompt", (payload) => {
      const roomId = String(payload?.roomId || socket.data.roomId || "");
      const room = rooms.get(roomId);
      const playerId = String(socket.data.playerId || "");
      if (!room) {
        emitError(socket, "ROOM_NOT_FOUND", "Room does not exist.");
        return;
      }
      if (!isAdminUser(playerId)) {
        emitError(socket, "FORBIDDEN", "Only the admin can add custom prompts.");
        return;
      }

      const en = String(payload?.en || "").trim();
      const ar = String(payload?.ar || "").trim();
      if (!en || !ar) {
        emitError(
          socket,
          "INVALID_PROMPT",
          "Custom prompt requires both EN and AR text.",
        );
        return;
      }

      room.customPrompts.push({
        id: createId("custom"),
        source: "custom",
        en,
        ar,
      });
      emitRoomState(io, room);
    });

    socket.on("admin_start_round", (payload) => {
      const roomId = String(payload?.roomId || socket.data.roomId || "");
      const room = rooms.get(roomId);
      const playerId = String(socket.data.playerId || "");
      if (!room) {
        emitError(socket, "ROOM_NOT_FOUND", "Room does not exist.");
        return;
      }
      if (!isRoomAdmin(room, playerId)) {
        emitError(socket, "FORBIDDEN", "Only the admin can start rounds.");
        return;
      }

      const result = startRound(io, room);
      if (!result.ok) {
        emitError(socket, result.code, result.message);
      }
    });

    socket.on("submit_gif", (payload) => {
      const roomId = String(payload?.roomId || socket.data.roomId || "");
      const room = rooms.get(roomId);
      const playerId = String(socket.data.playerId || "");
      if (!room) {
        emitError(socket, "ROOM_NOT_FOUND", "Room does not exist.");
        return;
      }
      if (room.phase !== PHASES.GIF_SEARCH) {
        emitError(socket, "INVALID_PHASE", "GIF submission is only allowed in GIF_SEARCH.");
        return;
      }
      if (!room.roundParticipantIds.has(playerId)) {
        emitError(socket, "NOT_PARTICIPANT", "You are not part of the current round.");
        return;
      }
      if (room.submissions.has(playerId)) {
        emitError(socket, "ALREADY_SUBMITTED", "You already submitted a GIF this round.");
        return;
      }

      const gif = payload?.gif;
      if (!gif?.id || !gif?.url) {
        emitError(socket, "INVALID_GIF", "gif.id and gif.url are required.");
        return;
      }

      room.submissions.set(playerId, {
        playerId,
        gif: {
          id: String(gif.id),
          url: String(gif.url),
          previewUrl: gif.previewUrl ? String(gif.previewUrl) : String(gif.url),
          title: gif.title ? String(gif.title) : "",
        },
        submittedAt: Date.now(),
      });

      emitRoomState(io, room);
      if (allRoundParticipantsSubmitted(room)) {
        transitionToVoting(io, room);
      }
    });

    socket.on("cast_vote", (payload) => {
      const roomId = String(payload?.roomId || socket.data.roomId || "");
      const room = rooms.get(roomId);
      const voterId = String(socket.data.playerId || "");
      if (!room) {
        emitError(socket, "ROOM_NOT_FOUND", "Room does not exist.");
        return;
      }
      if (room.phase !== PHASES.VOTING) {
        emitError(socket, "INVALID_PHASE", "Voting is only allowed in VOTING phase.");
        return;
      }
      if (!room.roundParticipantIds.has(voterId)) {
        emitError(socket, "NOT_PARTICIPANT", "You are not part of the current round.");
        return;
      }
      if (room.votes.has(voterId)) {
        emitError(socket, "ALREADY_VOTED", "You already voted this round.");
        return;
      }

      const targetPlayerId = String(payload?.targetPlayerId || "").trim();
      if (!targetPlayerId || !room.submissions.has(targetPlayerId)) {
        emitError(socket, "INVALID_TARGET", "Vote target is invalid.");
        return;
      }
      if (targetPlayerId === voterId) {
        emitError(socket, "SELF_VOTE_BLOCKED", "You cannot vote for your own GIF.");
        return;
      }

      room.votes.set(voterId, targetPlayerId);
      emitRoomState(io, room);
      if (allEligibleVotesCast(room)) {
        transitionToRoundResults(io, room);
      }
    });

    socket.on("disconnect", () => {
      const roomId = String(socket.data.roomId || "");
      if (!roomId) {
        return;
      }
      const room = rooms.get(roomId);
      if (!room) {
        return;
      }

      room.players.delete(socket.id);

      if (!room.players.size) {
        clearRoomTimers(room);
        rooms.delete(roomId);
        return;
      }

      if (room.adminId === socket.data.playerId) {
        const remainingPlayers = Array.from(room.players.values());
        if (remainingPlayers.length > 0) {
          room.adminId = remainingPlayers[0].id; // Give admin to the next available player
        }
      }

      emitRoomState(io, room);
      if (room.phase === PHASES.GIF_SEARCH && allRoundParticipantsSubmitted(room)) {
        transitionToVoting(io, room);
      }
      if (room.phase === PHASES.VOTING && allEligibleVotesCast(room)) {
        transitionToRoundResults(io, room);
      }
    });
  });
}

function createGameServer({ fetchImpl } = {}) {
  const app = createApp({ fetchImpl });
  const httpServer = http.createServer(app);
  const corsOrigin = process.env.CORS_ORIGIN || "*";

  const io = new Server(httpServer, {
    cors: {
      origin: corsOrigin === "*" ? true : corsOrigin.split(","),
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  const rooms = new Map();
  registerSocketHandlers(io, rooms);

  return { app, httpServer, io, rooms };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3001);
  const { httpServer } = createGameServer();
  httpServer.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Horoj Haniya backend listening on http://localhost:${port}`);
  });
}

module.exports = {
  ADMIN_DISCORD_ID,
  PHASES,
  DECK_MODES,
  PROMPT_REVEAL_SECONDS,
  GIF_SEARCH_SECONDS,
  VOTING_SECONDS,
  ROUND_RESULTS_SECONDS,
  DEFAULT_PROMPTS,
  clampMinPlayers,
  isAdminUser,
  normalizeDeckMode,
  createRoom,
  canStartRound,
  selectPrompt,
  buildPodium,
  buildRevealSchedule,
  normalizeKlipyResult,
  createApp,
  createGameServer,
  startRound,
};
