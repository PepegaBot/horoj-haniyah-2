import { describe, expect, it } from "vitest";
import {
  PHASES,
  getAudioCueForPhase,
  getVisibleRanks,
  i18n,
  phaseLabelKey,
} from "../app/game-helpers";

describe("frontend helper coverage", () => {
  it("maps phases to expected audio cue placeholders", () => {
    expect(getAudioCueForPhase(PHASES.LOBBY)).toBe("lobby_music.mp3");
    expect(getAudioCueForPhase(PHASES.PROMPT_REVEAL)).toBe("round_start.mp3");
    expect(getAudioCueForPhase(PHASES.GIF_SEARCH)).toBe(
      "search_phase_ticking.mp3",
    );
    expect(getAudioCueForPhase(PHASES.VOTING)).toBe("voting_music.mp3");
    expect(getAudioCueForPhase(PHASES.ROUND_RESULTS)).toBe("round_winner.mp3");
  });

  it("maps phase labels to bilingual dictionary keys", () => {
    expect(i18n.en[phaseLabelKey(PHASES.LOBBY)]).toBe("Lobby");
    expect(i18n.ar[phaseLabelKey(PHASES.VOTING)]).toBe("التصويت");
  });

  it("reveals podium ranks in timeline order", () => {
    const schedule = [
      { rank: 3, revealAtMs: 0 },
      { rank: 2, revealAtMs: 2200 },
      { rank: 1, revealAtMs: 4400 },
    ];

    expect(getVisibleRanks(schedule, 0)).toEqual([3]);
    expect(getVisibleRanks(schedule, 2500)).toEqual([2, 3]);
    expect(getVisibleRanks(schedule, 6000)).toEqual([1, 2, 3]);
  });
});
