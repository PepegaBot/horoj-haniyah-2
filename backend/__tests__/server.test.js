const request = require("supertest");
const {
  ADMIN_DISCORD_ID,
  DECK_MODES,
  PHASES,
  buildPodium,
  buildRevealSchedule,
  canStartRound,
  clampMinPlayers,
  createApp,
  createRoom,
  isAdminUser,
  selectPrompt,
  startRound,
} = require("../server");

function createIoMock() {
  const emissions = [];
  return {
    emissions,
    io: {
      to: () => ({
        emit: (event, payload) => {
          emissions.push({ event, payload });
        },
      }),
    },
  };
}

describe("admin and room guards", () => {
  it("enforces strict admin ID", () => {
    expect(isAdminUser(ADMIN_DISCORD_ID)).toBe(true);
    expect(isAdminUser(`${ADMIN_DISCORD_ID}x`)).toBe(false);
    expect(isAdminUser("217998454197190655")).toBe(false);
  });

  it("clamps min players between 1 and 3", () => {
    expect(clampMinPlayers(0)).toBe(1);
    expect(clampMinPlayers(4)).toBe(3);
    expect(clampMinPlayers(2)).toBe(2);
    expect(clampMinPlayers("not-number")).toBe(3);
  });
});

describe("prompt and phase behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("uses custom prompts when deck mode is CUSTOM and custom exists", () => {
    const room = createRoom("room_1");
    room.deckMode = DECK_MODES.CUSTOM;
    room.customPrompts = [
      { id: "custom_1", source: "custom", en: "EN", ar: "AR" },
    ];

    const selected = selectPrompt(room);
    expect(selected.id).toBe("custom_1");
  });

  it("falls back to default prompts when CUSTOM deck is empty", () => {
    const room = createRoom("room_1");
    room.deckMode = DECK_MODES.CUSTOM;
    room.customPrompts = [];

    const selected = selectPrompt(room);
    expect(selected.source).toBe("default");
  });

  it("requires minimum players before starting round", () => {
    const room = createRoom("room_1");
    room.minPlayers = 2;
    room.players.set("s1", { id: "u1", username: "A", avatarUrl: null });
    expect(canStartRound(room)).toBe(false);
  });

  it("starts round and enters PROMPT_REVEAL when requirements are met", () => {
    const room = createRoom("room_1");
    room.minPlayers = 2;
    room.players.set("s1", { id: "u1", username: "A", avatarUrl: null });
    room.players.set("s2", { id: "u2", username: "B", avatarUrl: null });
    const { io } = createIoMock();

    const result = startRound(io, room);

    expect(result.ok).toBe(true);
    expect(room.phase).toBe(PHASES.PROMPT_REVEAL);
    expect(room.roundParticipantIds.size).toBe(2);
    expect(room.currentPrompt).toBeTruthy();
  });
});

describe("podium and reveal ranking", () => {
  it("ranks by votes and breaks ties by earliest submission", () => {
    const room = createRoom("room_1");
    room.players.set("s1", { id: "u1", username: "Alpha", avatarUrl: null });
    room.players.set("s2", { id: "u2", username: "Bravo", avatarUrl: null });
    room.players.set("s3", { id: "u3", username: "Charlie", avatarUrl: null });
    room.scores.set("u1", 0);
    room.scores.set("u2", 0);
    room.scores.set("u3", 0);

    room.submissions.set("u1", {
      playerId: "u1",
      gif: { id: "g1", url: "https://gif/1", previewUrl: "https://gif/1" },
      submittedAt: 1000,
    });
    room.submissions.set("u2", {
      playerId: "u2",
      gif: { id: "g2", url: "https://gif/2", previewUrl: "https://gif/2" },
      submittedAt: 900,
    });
    room.submissions.set("u3", {
      playerId: "u3",
      gif: { id: "g3", url: "https://gif/3", previewUrl: "https://gif/3" },
      submittedAt: 1100,
    });

    room.votes.set("u1", "u2");
    room.votes.set("u2", "u1");
    room.votes.set("u3", "u1");

    const podium = buildPodium(room);
    expect(podium[0].playerId).toBe("u1");
    expect(podium[0].votes).toBe(2);
    expect(podium[1].playerId).toBe("u2");
    expect(room.scores.get("u1")).toBe(2);
    expect(room.scores.get("u2")).toBe(1);
  });

  it("builds reveal schedule from lowest rank to highest rank", () => {
    const revealSchedule = buildRevealSchedule([
      { rank: 1 },
      { rank: 2 },
      { rank: 3 },
    ]);

    expect(revealSchedule).toEqual([
      { rank: 3, revealAtMs: 0 },
      { rank: 2, revealAtMs: 2200 },
      { rank: 1, revealAtMs: 4400 },
    ]);
  });
});

describe("klipy proxy route", () => {
  const originalEnv = process.env.KLIPY_API_KEY;

  afterEach(() => {
    process.env.KLIPY_API_KEY = originalEnv;
  });

  it("returns normalized results from klipy", async () => {
    process.env.KLIPY_API_KEY = "test_key";
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        next: "next_cursor",
        results: [
          {
            id: "abc",
            title: "Wave",
            media_formats: {
              gif: { url: "https://static/abc.gif", preview: "https://static/p.gif" },
            },
          },
        ],
      }),
    });
    const app = createApp({ fetchImpl });

    const response = await request(app)
      .get("/api/klipy/search")
      .query({ q: "hello", limit: 10 });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.body.next).toBe("next_cursor");
    expect(response.body.results[0]).toEqual({
      id: "abc",
      title: "Wave",
      url: "https://static/abc.gif",
      previewUrl: "https://static/p.gif",
    });
  });

  it("fails when q query is missing", async () => {
    process.env.KLIPY_API_KEY = "test_key";
    const app = createApp({ fetchImpl: vi.fn() });
    const response = await request(app).get("/api/klipy/search");
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("MISSING_QUERY");
  });
});
