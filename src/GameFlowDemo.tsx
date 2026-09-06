import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./GameFlowDemo.css";
import {
  FACTION_LABEL,
  QUESTION_SETS,
  ROLES,
  type QuestionSet,
  type RoleKey,
} from "./gameData";
import { apiFetch } from "./lib/api";
import { useAuth } from "./hooks/useAuth";
import { LoginForm } from "./components/LoginForm";
import { useGameSocket, type GamePhase, type PublicPlayerView } from "./hooks/useGameSocket";

/**
 * INSECURE_GAME — real client, wired to the live backend over Socket.IO.
 *
 * This file used to be a pure click-through UI mockup (fake role switching,
 * fake vote tallies, a hand-advanced screen sequence). It's now driven by:
 *   - `room:state`         -> phase/round/players/voteTally/result/lockedQuestion (real)
 *   - `player:private_state` -> your own role/faction (real, server-decided)
 *   - action emits         -> game:lock_question_set / submit_answer / vote / use_skill
 *
 * Fixed in this pass:
 *   - Host authorization: the host now sends their Supabase access token on
 *     `room:join` (see useGameSocket.joinRoom + handleCreateRoom below). The
 *     backend verifies it and, only if it matches room.settings.hostId, uses
 *     that as the playerId — so `game:start` / `only_host_may_start` now
 *     correctly recognizes the real host.
 *   - Real question content: once the Bomber locks a set, the server fetches
 *     it from Mongo and broadcasts a sanitized copy on `room.lockedQuestion`
 *     (prompt + real option ids, no `isCorrect`). The Day-answer screen and
 *     the Seer's night check now use that when present, falling back to the
 *     local `QUESTION_SETS` mock only before a set has been locked yet.
 *     Locking itself now also fetches the real, host-authored list via
 *     `game:list_question_sets` instead of only the local mock ids.
 *   - Bomb placement: wired to the new `bomber_place_real_bomb` /
 *     `bomber_place_fake_bomb` skills. The round>1 Bomber screen now actually
 *     places bombs instead of just describing why it couldn't.
 *
 * Still a known simplification (unchanged from before): exactly 8 players are
 * required to start (see GameRoom.DEFAULT_ROLE_POOL) — confirm against the
 * real rules doc if the player count needs to be flexible.
 */

const ROLE_NAME_TO_KEY: Record<string, RoleKey> = {
  VILLAGER: "villager",
  SAGE: "wiseman",
  SEER: "seer",
  GUARDIAN: "protector",
  CHIEF: "villagehead",
  FOOL: "fool",
  BOMBER: "bomber",
  MASTERMIND: "mastermind",
};

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL as string;

type Screen = "lobby" | "qeditor" | "reveal" | "night" | "day" | "end";
type DayStep = "answer" | "discuss" | "vote";

function resolvePhaseToScreen(
  phase: GamePhase | undefined,
  round: number | undefined,
  hasRevealed: boolean
): { screen: Screen; round: number; dayStep: DayStep | null } {
  const r = round ?? 0;
  if (!phase || phase === "LOBBY") return { screen: "lobby", round: r, dayStep: null };
  if (phase === "NIGHT_1") {
    return hasRevealed ? { screen: "night", round: 1, dayStep: null } : { screen: "reveal", round: 1, dayStep: null };
  }
  if (phase === "DAY_ANSWER") return { screen: "day", round: r, dayStep: "answer" };
  if (phase === "DAY_DISCUSSION") return { screen: "day", round: r, dayStep: "discuss" };
  if (phase === "DAY_VOTE") return { screen: "day", round: r, dayStep: "vote" };
  if (phase === "NIGHT") return { screen: "night", round: r, dayStep: null };
  return { screen: "end", round: r, dayStep: null };
}

/** Synthetic option ids — see file header note: real question content/option
 *  ids from the backend don't exist yet, so these are placeholders. */
function syntheticOptionId(qs: QuestionSet, optIndex: number): string {
  return `demo:${qs.id}:opt-${optIndex}`;
}

/** Countdown driven by the server's clock (serverTimeMs / phaseEndsAtMs), never
 *  the client's own idea of time — matches backend rule [3.3]. */
function useServerCountdown(serverTimeMs: number | undefined, phaseEndsAtMs: number | null | undefined) {
  const offsetRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (serverTimeMs) offsetRef.current = serverTimeMs - Date.now();
  }, [serverTimeMs]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!phaseEndsAtMs) return null;
  const remainingMs = Math.max(0, phaseEndsAtMs - (now + offsetRef.current));
  const totalSec = Math.ceil(remainingMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export default function GameFlowDemo() {
  const socket = useGameSocket();

  const [appPhase, setAppPhase] = useState<"entry" | "join" | "game">("entry");
  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);

  const auth = useAuth();
  const [hostDisplayName, setHostDisplayName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showLoginForHost, setShowLoginForHost] = useState(false);

  const [questionSets] = useState<QuestionSet[]>(() => QUESTION_SETS.map((q) => ({ ...q, opts: [...q.opts] })));
  const [screenOverride, setScreenOverride] = useState<"qeditor" | null>(null);

  // Real, host-authored question sets from Mongo (routes/questions.ts), fetched
  // over the socket so a non-logged-in Bomber can still see them. Falls back to
  // the local `questionSets` mock above if the host hasn't authored any yet.
  const [realQuestionSets, setRealQuestionSets] = useState<
    { questionId: string; prompt: string; options: { optionId: string; text: string }[] }[] | null
  >(null);
  const [selectedRealQuestionId, setSelectedRealQuestionId] = useState<string | null>(null);
  const [bombPlacementResult, setBombPlacementResult] = useState<{ ok: boolean; reason?: string } | null>(null);

  const [hasRevealed, setHasRevealed] = useState(false);
  const [selectedQuestionSetIds, setSelectedQuestionSetIds] = useState<number[]>([]);
  const [lockResult, setLockResult] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  // Mastermind's swap needs TWO option ids at once (which position currently
  // holds the real bomb, which holds the fake one) — separate from the
  // single-option `selectedOptionId` used by Seer/Bomber pickers above.
  const [selectedSwapRealOptionId, setSelectedSwapRealOptionId] = useState<string | null>(null);
  const [selectedSwapFakeOptionId, setSelectedSwapFakeOptionId] = useState<string | null>(null);
  const [skillResult, setSkillResult] = useState<{ ok: boolean; reason?: string; data?: unknown } | null>(null);
  const [answerSubmitted, setAnswerSubmitted] = useState(false);
  const [voteCast, setVoteCast] = useState<string | null>(null);
  const [startGameError, setStartGameError] = useState<string | null>(null);
  const [startGameBusy, setStartGameBusy] = useState(false);

  const room = socket.roomState;
  const resolved = useMemo(
    () => resolvePhaseToScreen(room?.phase, room?.round, hasRevealed),
    [room?.phase, room?.round, hasRevealed]
  );
  const screen = screenOverride ?? resolved.screen;
  const countdown = useServerCountdown(room?.serverTimeMs, room?.phaseEndsAtMs);

  const myRole: RoleKey = socket.privateState?.role
    ? ROLE_NAME_TO_KEY[socket.privateState.role] ?? "villager"
    : "villager";
  const players: PublicPlayerView[] = room?.players ?? [];
  const otherPlayers = players.filter((p) => p.playerId !== socket.myPlayerId);

  // The question everyone should actually be shown: the server's real, locked
  // question once the Bomber has picked one (real prompt + real option ids),
  // falling back to the local `questionSets` mock only before that happens.
  const effectiveQuestion = useMemo(() => {
    if (room?.lockedQuestion) {
      return { prompt: room.lockedQuestion.prompt, options: room.lockedQuestion.options };
    }
    const mock = questionSets[0];
    return {
      prompt: mock.q,
      options: mock.opts.map((text, i) => ({ optionId: syntheticOptionId(mock, i), text })),
    };
  }, [room?.lockedQuestion, questionSets]);

  // Reset per-round/per-game local UI state when the server tells us the
  // underlying phase/round actually changed — these are UI affordances only,
  // never a source of truth (see class docblock).
  useEffect(() => {
    if (room?.phase === "LOBBY") {
      setHasRevealed(false);
      setSelectedQuestionSetIds([]);
      setSelectedRealQuestionId(null);
      setLockResult(null);
    }
  }, [room?.phase]);

  useEffect(() => {
    setAnswerSubmitted(false);
    setSelectedOptionId(null);
  }, [room?.phase, room?.round]);

  useEffect(() => {
    setVoteCast(null);
  }, [room?.round]);

  useEffect(() => {
    setSkillResult(null);
    setSelectedTargetId(null);
    setSelectedSwapRealOptionId(null);
    setSelectedSwapFakeOptionId(null);
  }, [room?.phase, room?.round]);

  useEffect(() => {
    setBombPlacementResult(null);
  }, [room?.phase, room?.round]);

  // Fetch the real host-authored question sets once we're actually in a room,
  // so the Bomber can lock a real one instead of only the local mock ids.
  const refreshRealQuestionSets = useCallback(async () => {
    const result = await socket.listQuestionSets();
    if (result.ok && result.data) setRealQuestionSets(result.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  useEffect(() => {
    if (appPhase !== "game") return;
    let cancelled = false;
    socket.listQuestionSets().then((result) => {
      if (cancelled) return;
      if (result.ok && result.data) setRealQuestionSets(result.data);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appPhase]);

  function handleLeaveRoom() {
    socket.leaveRoom();
    setAppPhase("entry");
    setScreenOverride(null);
  }

  async function handleCreateRoom() {
    setCreateError(null);
    // Product rule: joining needs no account, but hosting (creating a room) does.
    if (!auth.accessToken) {
      setShowLoginForHost(true);
      return;
    }
    setCreateBusy(true);
    try {
      const data = await apiFetch("/api/rooms", auth.accessToken, {
        method: "POST",
        body: JSON.stringify({ totalRounds: 3 }),
      });
      socket.joinRoom(data.roomId, hostDisplayName.trim() || auth.session?.user?.email || "Host", auth.accessToken);
      setAppPhase("game");
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreateBusy(false);
    }
  }

  function handleSubmitJoin() {
    if (!joinCode.trim()) {
      setJoinError("กรอกรหัสห้องก่อนนะ");
      return;
    }
    if (!joinName.trim()) {
      setJoinError("ตั้งชื่อที่จะใช้ในเกมด้วย");
      return;
    }
    setJoinError(null);
    // Passing the token here too is harmless and correct: the backend only
    // ever treats it as meaningful if it verifies AND matches this room's
    // hostId. A regular player (no account, or logged in but not the host)
    // is unaffected either way — see sockets/index.ts room:join.
    socket.joinRoom(joinCode.trim(), joinName.trim(), auth.accessToken);
    setAppPhase("game");
  }

  async function handleStartGame() {
    setStartGameBusy(true);
    setStartGameError(null);
    const result = await socket.startGame();
    setStartGameBusy(false);
    if (!result.ok) setStartGameError(result.reason ?? "unknown_error");
  }

  function toggleQuestionSet(id: number) {
    setSelectedQuestionSetIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function confirmLockQuestionSet() {
    // Prefer a real, host-authored question set (real Mongo id + real option
    // ids) if one was picked; fall back to the local mock only if the host
    // never authored any questions for this room via POST /api/questions/:roomId.
    const idToLock = selectedRealQuestionId ?? (selectedQuestionSetIds.length > 0 ? String(selectedQuestionSetIds[0]) : null);
    if (!idToLock) return;
    const result = await socket.lockQuestionSet(idToLock);
    setLockResult(result);
  }

  async function confirmPlaceBomb(kind: "real" | "fake") {
    if (!selectedOptionId) return;
    const result = await socket.useSkill({
      skill: kind === "real" ? "bomber_place_real_bomb" : "bomber_place_fake_bomb",
      optionId: selectedOptionId,
    });
    setBombPlacementResult(result);
  }

  async function confirmAnswer() {
    if (!selectedOptionId) return;
    const result = await socket.submitAnswer(selectedOptionId);
    if (result.ok) setAnswerSubmitted(true);
  }

  async function confirmVote() {
    if (!selectedTargetId) return;
    const result = await socket.castVote(selectedTargetId);
    if (result.ok) setVoteCast(selectedTargetId);
  }

  async function confirmSkillWithTarget(skill: string) {
    if (!selectedTargetId) return;
    const result = await socket.useSkill({ skill, targetPlayerId: selectedTargetId });
    setSkillResult(result);
  }

  async function confirmSkillWithOption(skill: string) {
    if (!selectedOptionId) return;
    const result = await socket.useSkill({ skill, optionId: selectedOptionId });
    setSkillResult(result);
  }

  async function confirmMastermindSwap() {
    if (!selectedSwapRealOptionId || !selectedSwapFakeOptionId) return;
    // Backend requires both ids together or it fails with missing_option_ids
    // (sockets/index.ts "mastermind_swap" case) — never send just one.
    const result = await socket.useSkill({
      skill: "mastermind_swap",
      realOptionId: selectedSwapRealOptionId,
      fakeOptionId: selectedSwapFakeOptionId,
    });
    setSkillResult(result);
  }

  const phoneMode: "night" | "day" = screen === "day" ? "day" : "night";

  // -------- Not connected yet: entry / join screens --------
  if (appPhase !== "game") {
    return (
      <div className="ig-root">
        <div className="ig-phone">
          <div className="ig-content" style={{ paddingTop: 48 }}>
            {appPhase === "entry" ? (
              <EntryScreen
                auth={auth}
                showLoginForHost={showLoginForHost}
                hostDisplayName={hostDisplayName}
                onHostDisplayNameChange={setHostDisplayName}
                createBusy={createBusy}
                createError={createError}
                onCreate={handleCreateRoom}
                onJoin={() => setAppPhase("join")}
                onSignOut={() => auth.signOut()}
                backendUrl={BACKEND_URL}
              />
            ) : (
              <JoinScreen
                code={joinCode}
                name={joinName}
                error={joinError ?? socket.joinError}
                onCodeChange={setJoinCode}
                onNameChange={setJoinName}
                onBack={() => {
                  setJoinError(null);
                  setAppPhase("entry");
                }}
                onSubmit={handleSubmitJoin}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ig-root">
      <div className={`ig-phone${phoneMode === "day" ? " day" : ""}`}>
        <StepperBar phase={room?.phase} round={resolved.round} screen={screen} connected={socket.connected} />

        <div className="ig-content">
          {screen === "lobby" && (
            <LobbyScreen
              roomId={room?.roomId ?? "..."}
              players={players}
              onManageQuestions={() => setScreenOverride("qeditor")}
              onLeaveRoom={handleLeaveRoom}
              onStartGame={handleStartGame}
              startGameBusy={startGameBusy}
              startGameError={startGameError}
            />
          )}
          {screen === "qeditor" && (
            <QuestionEditorScreen
              questionSets={questionSets}
              roomId={room?.roomId}
              accessToken={auth.accessToken}
              onBack={() => setScreenOverride(null)}
              onQuestionsChanged={refreshRealQuestionSets}
            />
          )}
          {screen === "reveal" && <RevealScreen role={myRole} revealed={hasRevealed} onFlip={() => setHasRevealed((r) => !r)} />}
          {screen === "night" && (
            <NightScreen
              round={resolved.round}
              role={myRole}
              questionSets={questionSets}
              realQuestionSets={realQuestionSets}
              selectedQuestionSetIds={selectedQuestionSetIds}
              selectedRealQuestionId={selectedRealQuestionId}
              onToggleQuestion={toggleQuestionSet}
              onSelectRealQuestion={setSelectedRealQuestionId}
              onConfirmLock={confirmLockQuestionSet}
              lockResult={lockResult}
              otherPlayers={otherPlayers}
              selectedTargetId={selectedTargetId}
              onSelectTarget={setSelectedTargetId}
              onConfirmSkillTarget={confirmSkillWithTarget}
              selectedOptionId={selectedOptionId}
              onSelectOption={setSelectedOptionId}
              onConfirmSkillOption={confirmSkillWithOption}
              skillResult={skillResult}
              effectiveQuestion={effectiveQuestion}
              onPlaceBomb={confirmPlaceBomb}
              bombPlacementResult={bombPlacementResult}
              selectedSwapRealOptionId={selectedSwapRealOptionId}
              selectedSwapFakeOptionId={selectedSwapFakeOptionId}
              onSelectSwapRealOption={setSelectedSwapRealOptionId}
              onSelectSwapFakeOption={setSelectedSwapFakeOptionId}
              onConfirmSwap={confirmMastermindSwap}
            />
          )}
          {screen === "day" && resolved.dayStep && (
            <DayScreen
              round={resolved.round}
              dayStep={resolved.dayStep}
              role={myRole}
              countdown={countdown}
              question={effectiveQuestion}
              selectedOptionId={selectedOptionId}
              onSelectOption={setSelectedOptionId}
              answerSubmitted={answerSubmitted}
              onConfirmAnswer={confirmAnswer}
              otherPlayers={otherPlayers}
              selectedTargetId={selectedTargetId}
              onSelectTarget={setSelectedTargetId}
              voteCast={voteCast}
              onConfirmVote={confirmVote}
              voteTally={room?.voteTally}
              onGuardianReveal={() => socket.useSkill({ skill: "guardian_reveal" }).then(setSkillResult)}
              onChiefReveal={() =>
                socket.useSkill({ skill: "chief_advanced_reveal", optionId: effectiveQuestion.options[0]?.optionId }).then(setSkillResult)
              }
              skillResult={skillResult}
            />
          )}
          {screen === "end" && <EndScreen result={room?.result} onLeave={handleLeaveRoom} />}
        </div>

        {screen === "qeditor" ? null : <Footer screen={screen} />}
      </div>
    </div>
  );
}

/* ---------------- Stepper ---------------- */

function StepperBar({
  phase,
  round,
  screen,
  connected,
}: {
  phase: GamePhase | undefined;
  round: number;
  screen: Screen;
  connected: boolean;
}) {
  const phaseLabel =
    screen === "lobby"
      ? "ล็อบบี้ห้องเกม"
      : screen === "qeditor"
      ? "จัดการคลังคำถาม"
      : screen === "reveal"
      ? "เปิดการ์ดบทบาท"
      : screen === "night"
      ? round === 1
        ? "สกิลคืนแรก"
        : `สกิลกลางคืน · รอบ ${round}`
      : screen === "day"
      ? phase === "DAY_ANSWER"
        ? "ช่วงตอบคำถาม"
        : phase === "DAY_DISCUSSION"
        ? "ช่วงพูดคุยหารือ"
        : "ช่วงโหวต"
      : "สรุปผลเกม";

  return (
    <div className="ig-stepper">
      <div className="ig-stepper-top">
        <span className="ig-round-tag">{connected ? "🟢 เชื่อมต่อแล้ว" : "🔴 ยังไม่เชื่อมต่อ"}</span>
        <span className="ig-round-tag">{phase ?? "..."}</span>
      </div>
      <div className="ig-phase-name">{phaseLabel}</div>
    </div>
  );
}

/* ---------------- Footer (informational only — the server drives phase changes) ---------------- */

function Footer({ screen }: { screen: Screen }) {
  if (screen === "lobby" || screen === "reveal" || screen === "end") return null;
  return (
    <div className="ig-footer">
      <span className="ig-sub" style={{ textAlign: "center", width: "100%" }}>
        เซิร์ฟเวอร์เป็นคนควบคุมเวลาและเปลี่ยนช่วงเกมเอง — ใช้ปุ่ม "ยืนยัน" ในแต่ละช่วงเพื่อส่งการกระทำของคุณ
      </span>
    </div>
  );
}

/* ---------------- Option row (shared) ---------------- */

function OptionRow({
  label,
  selected,
  onClick,
  leading,
  disabled,
}: {
  label: React.ReactNode;
  selected: boolean;
  onClick: () => void;
  leading?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div
      className={`ig-opt${selected ? " selected" : ""}`}
      onClick={disabled ? undefined : onClick}
      style={disabled ? { opacity: 0.5, pointerEvents: "none" } : undefined}
    >
      <div style={leading ? { display: "flex", alignItems: "center", gap: 10 } : undefined}>
        {leading}
        {label}
      </div>
      <div className="ig-opt-radio" />
    </div>
  );
}

function ResultBanner({ result }: { result: { ok: boolean; reason?: string; data?: unknown } | null }) {
  if (!result) return null;
  return (
    <div className="ig-card" style={{ textAlign: "center" }}>
      {result.ok ? (
        <span className="ig-pill">
          ✅ สำเร็จ{result.data ? ` — ${JSON.stringify(result.data)}` : ""}
        </span>
      ) : (
        <span className="ig-pill warn">❌ ไม่สำเร็จ: {result.reason}</span>
      )}
    </div>
  );
}

/* ---------------- Entry (create vs join) ---------------- */

function EntryScreen({
  auth,
  showLoginForHost,
  hostDisplayName,
  onHostDisplayNameChange,
  createBusy,
  createError,
  onCreate,
  onJoin,
  onSignOut,
  backendUrl,
}: {
  auth: { accessToken: string | null; session: { user: { email?: string } } | null; loading: boolean };
  showLoginForHost: boolean;
  hostDisplayName: string;
  onHostDisplayNameChange: (v: string) => void;
  createBusy: boolean;
  createError: string | null;
  onCreate: () => void;
  onJoin: () => void;
  onSignOut: () => void;
  backendUrl: string;
}) {
  const isLoggedIn = !!auth.accessToken;

  return (
    <>
      <div className="ig-logo-mark">💣</div>
      <h1 className="ig-title" style={{ textAlign: "center" }}>
        INSECURE_GAME
      </h1>
      <p className="ig-sub" style={{ textAlign: "center" }}>
        เกมจับผิดสายลับปนระเบิด เล่นเป็นกลุ่มผ่านมือถือของแต่ละคน
      </p>
      {!backendUrl && (
        <div className="ig-field-error">ยังไม่ได้ตั้งค่า VITE_BACKEND_URL ใน .env ของฝั่ง frontend</div>
      )}

      <button className="ig-btn ig-btn-primary" onClick={onJoin}>
        เข้าร่วมห้องที่มีอยู่ (ไม่ต้องล็อกอิน)
      </button>

      <div className="ig-card" style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>สร้างห้องใหม่ (Host)</div>

        {!isLoggedIn && !showLoginForHost && (
          <>
            <p className="ig-sub" style={{ marginBottom: 8 }}>
              ต้องเข้าสู่ระบบก่อนถึงจะสร้างห้องได้ (ผู้เข้าร่วมห้องคนอื่นไม่ต้องล็อกอิน)
            </p>
            <button className="ig-btn ig-btn-ghost" onClick={onCreate}>
              เข้าสู่ระบบเพื่อสร้างห้อง
            </button>
          </>
        )}

        {!isLoggedIn && showLoginForHost && (
          <div style={{ marginTop: 4 }}>
            <LoginForm />
          </div>
        )}

        {isLoggedIn && (
          <>
            <p className="ig-sub" style={{ marginBottom: 8 }}>
              เข้าสู่ระบบแล้วในนาม {auth.session?.user?.email ?? "ผู้ใช้"} ·{" "}
              <span style={{ textDecoration: "underline", cursor: "pointer" }} onClick={onSignOut}>
                ออกจากระบบ
              </span>
            </p>
            <div className="ig-field">
              <label>ชื่อที่ใช้ในเกม</label>
              <input
                value={hostDisplayName}
                onChange={(e) => onHostDisplayNameChange(e.target.value)}
                placeholder="เช่น มายด์"
              />
            </div>
            {createError && <div className="ig-field-error">{createError}</div>}
            <button className="ig-btn ig-btn-primary" onClick={onCreate} disabled={createBusy}>
              {createBusy ? "กำลังสร้างห้อง..." : "สร้างห้องใหม่ (Host)"}
            </button>
          </>
        )}
      </div>
    </>
  );
}

/* ---------------- Join room (code + name) ---------------- */

function JoinScreen({
  code,
  name,
  error,
  onCodeChange,
  onNameChange,
  onBack,
  onSubmit,
}: {
  code: string;
  name: string;
  error: string | null;
  onCodeChange: (v: string) => void;
  onNameChange: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <>
      <h1 className="ig-title">เข้าร่วมห้อง</h1>
      <p className="ig-sub">
        กรอกรหัสห้อง 8 ตัวที่ Host ให้มา (ตัวใหญ่/เลข — ไม่สนใจตัวเล็ก-ใหญ่)
      </p>

      <div className="ig-field">
        <label>รหัสห้อง</label>
        <input
          className="code"
          value={code}
          onChange={(e) => onCodeChange(e.target.value.toUpperCase())}
          placeholder="B7K2X9AB"
          maxLength={8}
        />
      </div>

      <div className="ig-field">
        <label>ชื่อที่ใช้ในเกม</label>
        <input value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="เช่น มายด์" maxLength={20} />
      </div>

      {error && <div className="ig-field-error">{error}</div>}

      <div className="ig-entry-actions">
        <button className="ig-btn ig-btn-primary" onClick={onSubmit}>
          เข้าร่วมห้อง
        </button>
        <button className="ig-btn ig-btn-ghost" onClick={onBack}>
          ← กลับ
        </button>
      </div>
    </>
  );
}

/* ---------------- Lobby ---------------- */

function LobbyScreen({
  roomId,
  players,
  onManageQuestions,
  onLeaveRoom,
  onStartGame,
  startGameBusy,
  startGameError,
}: {
  roomId: string;
  players: PublicPlayerView[];
  onManageQuestions: () => void;
  onLeaveRoom: () => void;
  onStartGame: () => void;
  startGameBusy: boolean;
  startGameError: string | null;
}) {
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="ig-pill">รหัสห้อง</span>
        <button
          className="ig-btn ig-btn-ghost"
          style={{ width: "auto", padding: "6px 12px", fontSize: 12 }}
          onClick={onLeaveRoom}
        >
          ออกจากห้อง
        </button>
      </div>
      <div className="ig-room-code">{roomId}</div>
      <p className="ig-sub" style={{ textAlign: "center", marginTop: -10 }}>
        ผู้เล่นเข้าห้องด้วยรหัสห้องนี้ — ตอนนี้ต้องมีผู้เล่นครบ 8 คนพอดีถึงจะเริ่มได้ (ชั่วคราว ดูหมายเหตุ role distribution ในโค้ด backend)
      </p>
      <div className="ig-card">
        {players.length === 0 && <p className="ig-sub">ยังไม่มีผู้เล่นเข้าห้อง</p>}
        {players.map((p) => (
          <div className="ig-player-row" key={p.playerId}>
            <div className="ig-avatar">{p.displayName[0]}</div>
            <div className="ig-player-name">
              {p.displayName} {!p.connected && "(หลุดการเชื่อมต่อ)"}
            </div>
          </div>
        ))}
      </div>
      <button className="ig-btn ig-btn-ghost" style={{ marginBottom: 10 }} onClick={onManageQuestions}>
        🗂️ จัดการคำถาม
      </button>
      {startGameError && <div className="ig-field-error">เริ่มเกมไม่สำเร็จ: {startGameError}</div>}
      <button className="ig-btn ig-btn-primary" onClick={onStartGame} disabled={startGameBusy}>
        {startGameBusy ? "กำลังเริ่ม..." : "เริ่มเกม"}
      </button>
    </>
  );
}

/* ---------------- Question editor (host) — wired to routes/questions.ts ---------------- */

interface RealQuestionDoc {
  _id: string;
  prompt: string;
  options: { optionId: string; text: string; isCorrect: boolean }[];
  lockedForRoomId: string | null;
}

/** Draft option row while composing a new question — before it's saved. */
interface DraftOption {
  optionId: string;
  text: string;
}

function QuestionEditorScreen({
  questionSets,
  roomId,
  accessToken,
  onBack,
  onQuestionsChanged,
}: {
  questionSets: QuestionSet[];
  roomId: string | undefined;
  accessToken: string | null;
  onBack: () => void;
  onQuestionsChanged: () => void;
}) {
  const [realQuestions, setRealQuestions] = useState<RealQuestionDoc[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [prompt, setPrompt] = useState("");
  const [options, setOptions] = useState<DraftOption[]>([
    { optionId: "o1", text: "" },
    { optionId: "o2", text: "" },
  ]);
  const [correctOptionId, setCorrectOptionId] = useState<string>("o1");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const canManage = !!roomId && !!accessToken;

  async function loadQuestions() {
    if (!canManage) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiFetch(`/api/questions/${roomId}`, accessToken);
      setRealQuestions(data);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadQuestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, accessToken]);

  function updateOptionText(optionId: string, text: string) {
    setOptions((prev) => prev.map((o) => (o.optionId === optionId ? { ...o, text } : o)));
  }

  function addOption() {
    if (options.length >= 6) return;
    const nextId = `o${options.length + 1}`;
    setOptions((prev) => [...prev, { optionId: nextId, text: "" }]);
  }

  function removeOption(optionId: string) {
    if (options.length <= 2) return;
    setOptions((prev) => prev.filter((o) => o.optionId !== optionId));
    if (correctOptionId === optionId) setCorrectOptionId(options[0].optionId);
  }

  function resetForm() {
    setPrompt("");
    setOptions([
      { optionId: "o1", text: "" },
      { optionId: "o2", text: "" },
    ]);
    setCorrectOptionId("o1");
  }

  async function handleCreateQuestion() {
    setSaveError(null);
    if (!canManage) return;
    if (!prompt.trim()) {
      setSaveError("ใส่คำถามก่อนนะ");
      return;
    }
    const trimmedOptions = options.map((o) => ({ ...o, text: o.text.trim() }));
    if (trimmedOptions.some((o) => !o.text)) {
      setSaveError("ตัวเลือกทุกข้อต้องมีข้อความ");
      return;
    }
    setSaving(true);
    try {
      await apiFetch(`/api/questions/${roomId}`, accessToken, {
        method: "POST",
        body: JSON.stringify({
          prompt: prompt.trim(),
          options: trimmedOptions.map((o) => ({
            optionId: o.optionId,
            text: o.text,
            isCorrect: o.optionId === correctOptionId,
          })),
        }),
      });
      resetForm();
      await loadQuestions();
      onQuestionsChanged();
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <>
        <p className="ig-sub">
          ต้องเข้าสู่ระบบด้วยบัญชี Host ของห้องนี้ก่อนถึงจะสร้าง/แก้ไขคำถามจริงได้ (ต้องส่ง access token ไปยัง{" "}
          <code>POST /api/questions/{"{roomId}"}</code>) — ตอนนี้ยังไม่มี access token ในเซสชันนี้ จึงแสดงชุดคำถามจำลองไว้แทน
        </p>
        {questionSets.map((qs) => (
          <div className="ig-card" key={qs.id}>
            <span className="ig-pill">{qs.name}</span>
            <div style={{ fontWeight: 600, marginTop: 6 }}>{qs.q}</div>
            {qs.opts.map((o, i) => (
              <div key={i} className="ig-sub">
                {i + 1}. {o}
              </div>
            ))}
          </div>
        ))}
        <button className="ig-btn ig-btn-ghost" onClick={onBack}>
          ← กลับไปล็อบบี้
        </button>
      </>
    );
  }

  return (
    <>
      <p className="ig-sub">สร้างคำถามจริงสำหรับห้องนี้ — บันทึกแล้ว Bomber จะเห็นในตอนล็อกชุดคำถามคืนแรก</p>

      <div className="ig-card">
        <div className="ig-field">
          <label>คำถาม</label>
          <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="พิมพ์คำถาม..." maxLength={200} />
        </div>
        {options.map((o, i) => (
          <div key={o.optionId} className="ig-field" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="radio"
              name="correctOption"
              checked={correctOptionId === o.optionId}
              onChange={() => setCorrectOptionId(o.optionId)}
              title="ตัวเลือกที่ถูกต้อง"
            />
            <input
              style={{ flex: 1 }}
              value={o.text}
              onChange={(e) => updateOptionText(o.optionId, e.target.value)}
              placeholder={`ตัวเลือก ${i + 1}`}
              maxLength={120}
            />
            {options.length > 2 && (
              <button
                className="ig-btn ig-btn-ghost"
                style={{ width: "auto", padding: "4px 10px" }}
                onClick={() => removeOption(o.optionId)}
              >
                ลบ
              </button>
            )}
          </div>
        ))}
        <button className="ig-btn ig-btn-ghost" style={{ marginTop: 4 }} onClick={addOption} disabled={options.length >= 6}>
          + เพิ่มตัวเลือก
        </button>
        {saveError && <div className="ig-field-error">{saveError}</div>}
        <button className="ig-btn ig-btn-primary" style={{ marginTop: 8 }} onClick={handleCreateQuestion} disabled={saving}>
          {saving ? "กำลังบันทึก..." : "บันทึกคำถามนี้"}
        </button>
      </div>

      <div style={{ fontWeight: 600, marginTop: 12, marginBottom: 4 }}>คำถามที่สร้างไว้แล้วในห้องนี้</div>
      {loading && <p className="ig-sub">กำลังโหลด...</p>}
      {loadError && <div className="ig-field-error">โหลดคำถามไม่สำเร็จ: {loadError}</div>}
      {!loading && realQuestions && realQuestions.length === 0 && <p className="ig-sub">ยังไม่มีคำถามที่สร้างไว้</p>}
      {realQuestions?.map((q) => (
        <div className="ig-card" key={q._id}>
          <div style={{ fontWeight: 600 }}>{q.prompt}</div>
          {q.options.map((o) => (
            <div key={o.optionId} className="ig-sub">
              {o.isCorrect ? "✅" : "▫️"} {o.text}
            </div>
          ))}
          {q.lockedForRoomId && <span className="ig-pill warn">ล็อกแล้ว — แก้ไขไม่ได้</span>}
        </div>
      ))}

      <button className="ig-btn ig-btn-ghost" style={{ marginTop: 10 }} onClick={onBack}>
        ← กลับไปล็อบบี้
      </button>
    </>
  );
}

/* ---------------- Role reveal ---------------- */

function RevealScreen({ role, revealed, onFlip }: { role: RoleKey; revealed: boolean; onFlip: () => void }) {
  const info = ROLES[role];
  return (
    <>
      <p className="ig-sub">แตะที่การ์ดเพื่อเปิดดูบทบาทลับของคุณ (มาจาก player:private_state จริง) ห้ามให้ผู้เล่นคนอื่นเห็นหน้าจอนี้</p>
      <div className="ig-role-flip-wrap">
        <div className={`ig-role-flip${revealed ? " flipped" : ""}`} onClick={onFlip}>
          <div className="ig-role-face back">
            <div className="ig-qmark">?</div>
          </div>
          <div className="ig-role-face front">
            <div className="ig-role-icon">{info.icon}</div>
            <div className="ig-role-name ig-display">{info.name}</div>
            <span className={`ig-role-faction ${info.faction}`}>{FACTION_LABEL[info.faction]}</span>
            <div className="ig-role-desc">{info.desc}</div>
          </div>
        </div>
      </div>
      {revealed && (
        <button className="ig-btn ig-btn-primary" style={{ marginTop: 12 }} onClick={onFlip}>
          จำบทบาทแล้ว ไปต่อ (รอเซิร์ฟเวอร์เปิดช่วงคืนแรก)
        </button>
      )}
    </>
  );
}

/* ---------------- Player picker (shared) ---------------- */

function PlayerPicker({
  players,
  selectedId,
  onSelect,
}: {
  players: PublicPlayerView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (players.length === 0) return <p className="ig-sub">ยังไม่มีผู้เล่นคนอื่นในห้อง</p>;
  return (
    <>
      {players.map((p) => (
        <OptionRow
          key={p.playerId}
          selected={selectedId === p.playerId}
          onClick={() => onSelect(p.playerId)}
          leading={<div className="ig-avatar small">{p.displayName[0]}</div>}
          label={p.displayName}
        />
      ))}
    </>
  );
}

/* ---------------- Night screen ---------------- */

function NightScreen({
  round,
  role,
  questionSets,
  realQuestionSets,
  selectedQuestionSetIds,
  selectedRealQuestionId,
  onToggleQuestion,
  onSelectRealQuestion,
  onConfirmLock,
  lockResult,
  otherPlayers,
  selectedTargetId,
  onSelectTarget,
  onConfirmSkillTarget,
  selectedOptionId,
  onSelectOption,
  onConfirmSkillOption,
  skillResult,
  effectiveQuestion,
  onPlaceBomb,
  bombPlacementResult,
  selectedSwapRealOptionId,
  selectedSwapFakeOptionId,
  onSelectSwapRealOption,
  onSelectSwapFakeOption,
  onConfirmSwap,
}: {
  round: number;
  role: RoleKey;
  questionSets: QuestionSet[];
  realQuestionSets: { questionId: string; prompt: string; options: { optionId: string; text: string }[] }[] | null;
  selectedQuestionSetIds: number[];
  selectedRealQuestionId: string | null;
  onToggleQuestion: (id: number) => void;
  onSelectRealQuestion: (id: string) => void;
  onConfirmLock: () => void;
  lockResult: { ok: boolean; reason?: string } | null;
  otherPlayers: PublicPlayerView[];
  selectedTargetId: string | null;
  onSelectTarget: (id: string) => void;
  onConfirmSkillTarget: (skill: string) => void;
  selectedOptionId: string | null;
  onSelectOption: (id: string) => void;
  onConfirmSkillOption: (skill: string) => void;
  skillResult: { ok: boolean; reason?: string; data?: unknown } | null;
  effectiveQuestion: { prompt: string; options: { optionId: string; text: string }[] };
  onPlaceBomb: (kind: "real" | "fake") => void;
  bombPlacementResult: { ok: boolean; reason?: string } | null;
  selectedSwapRealOptionId: string | null;
  selectedSwapFakeOptionId: string | null;
  onSelectSwapRealOption: (id: string) => void;
  onSelectSwapFakeOption: (id: string) => void;
  onConfirmSwap: () => void;
}) {
  if (round === 1 && role === "bomber") {
    const hasRealSets = !!realQuestionSets && realQuestionSets.length > 0;
    return (
      <>
        <span className="ig-pill warn">💣 สิทธิ์นักวางระเบิด</span>
        <h1 className="ig-title">เลือกล็อกชุดคำถาม</h1>
        <p className="ig-sub">
          {hasRealSets
            ? "เลือกชุดคำถามจริงที่ Host สร้างไว้ แล้วกดยืนยัน — ล็อกได้ทีละชุด"
            : "Host ยังไม่ได้สร้างชุดคำถามจริงสำหรับห้องนี้ (POST /api/questions/:roomId) จึงแสดงชุดจำลองไว้ก่อน — เลือกแล้วกดยืนยันได้ตามปกติ แต่เนื้อหาจะไม่ตรงกับที่ Seer/ผู้เล่นคนอื่นเห็นจนกว่า Host จะสร้างชุดจริง"}
        </p>
        {hasRealSets
          ? realQuestionSets!.map((qs) => (
              <OptionRow
                key={qs.questionId}
                selected={selectedRealQuestionId === qs.questionId}
                onClick={() => onSelectRealQuestion(qs.questionId)}
                disabled={!!lockResult?.ok}
                label={
                  <div>
                    <div style={{ fontWeight: 600 }}>{qs.prompt}</div>
                    <div style={{ fontSize: 11.5, color: "var(--night-ink-dim)", marginTop: 2 }}>
                      {qs.options.map((o) => o.text).join(" · ")}
                    </div>
                  </div>
                }
              />
            ))
          : questionSets.map((qs) => (
              <OptionRow
                key={qs.id}
                selected={selectedQuestionSetIds.includes(qs.id)}
                onClick={() => onToggleQuestion(qs.id)}
                disabled={!!lockResult?.ok}
                label={
                  <div>
                    <div style={{ fontWeight: 600 }}>{qs.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--night-ink-dim)", marginTop: 2 }}>{qs.q}</div>
                  </div>
                }
              />
            ))}
        <button
          className="ig-btn ig-btn-brass"
          style={{ marginTop: 8 }}
          disabled={(hasRealSets ? !selectedRealQuestionId : selectedQuestionSetIds.length === 0) || !!lockResult?.ok}
          onClick={onConfirmLock}
        >
          ยืนยันล็อกชุดคำถาม
        </button>
        <ResultBanner result={lockResult} />
      </>
    );
  }

  if (round === 1 && role === "villager") {
    return (
      <>
        <span className="ig-pill">🌾 สิทธิ์ชาวบ้าน</span>
        <h1 className="ig-title">เลือกยึดโยงผู้เล่น 1 คน</h1>
        <p className="ig-sub">คุณจะไม่ทราบฝ่ายหรือชื่อบทบาทของคนที่เลือก</p>
        <PlayerPicker players={otherPlayers} selectedId={selectedTargetId} onSelect={onSelectTarget} />
        <button
          className="ig-btn ig-btn-brass"
          style={{ marginTop: 8 }}
          disabled={!selectedTargetId || !!skillResult?.ok}
          onClick={() => onConfirmSkillTarget("villager_pick")}
        >
          ยืนยันเลือก
        </button>
        <ResultBanner result={skillResult} />
      </>
    );
  }

  if (role === "wiseman") {
    return (
      <>
        <span className="ig-pill">🔍 สิทธิ์ผู้มีปัญญา</span>
        <h1 className="ig-title">ตรวจสอบผู้เล่น 1 คน</h1>
        <p className="ig-sub">
          {round === 1 ? 'คืนนี้ตรวจได้เฉพาะ "ฝ่าย"' : 'ตั้งแต่คืนนี้ ตรวจได้ทั้ง "ฝ่ายและบทบาท"'}
        </p>
        <PlayerPicker players={otherPlayers} selectedId={selectedTargetId} onSelect={onSelectTarget} />
        <button
          className="ig-btn ig-btn-brass"
          style={{ marginTop: 8 }}
          disabled={!selectedTargetId}
          onClick={() => onConfirmSkillTarget("sage_investigate")}
        >
          ยืนยันตรวจสอบ
        </button>
        <ResultBanner result={skillResult} />
      </>
    );
  }

  if (round === 1 && role === "seer") {
    return (
      <>
        <span className="ig-pill">👁️ สิทธิ์ผู้หยั่งรู้</span>
        <h1 className="ig-title">ตรวจสอบคำถาม</h1>
        <p className="ig-sub">เลือกตัวเลือกคำถาม 1 ข้อ เพื่อตรวจว่า "เสี่ยง" หรือ "ปลอดภัย"</p>
        {effectiveQuestion.options.map((o) => (
          <OptionRow
            key={o.optionId}
            label={o.text}
            selected={selectedOptionId === o.optionId}
            onClick={() => onSelectOption(o.optionId)}
          />
        ))}
        <button
          className="ig-btn ig-btn-brass"
          style={{ marginTop: 8 }}
          disabled={!selectedOptionId}
          onClick={() => onConfirmSkillOption("seer_check_option")}
        >
          ยืนยันตรวจสอบ
        </button>
        <ResultBanner result={skillResult} />
      </>
    );
  }

  if (round > 1 && role === "bomber") {
    return (
      <>
        <span className="ig-pill warn">💣 สิทธิ์นักวางระเบิด</span>
        <h1 className="ig-title">วางระเบิด</h1>
        <p className="ig-sub">
          เลือกตัวเลือกคำถาม 1 ข้อ แล้ววางระเบิดจริง (ใช้โควตา 3 ลูกต่อเกม) หรือระเบิดหลอก (ได้แค่ 1 ลูกต่อคืน ตั้งแต่คืนที่ 2)
        </p>
        {effectiveQuestion.options.map((o) => (
          <OptionRow
            key={o.optionId}
            label={o.text}
            selected={selectedOptionId === o.optionId}
            onClick={() => onSelectOption(o.optionId)}
          />
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="ig-btn ig-btn-brass" style={{ flex: 1 }} disabled={!selectedOptionId} onClick={() => onPlaceBomb("real")}>
            💣 วางระเบิดจริง
          </button>
          <button className="ig-btn ig-btn-ghost" style={{ flex: 1 }} disabled={!selectedOptionId} onClick={() => onPlaceBomb("fake")}>
            🎭 วางระเบิดหลอก
          </button>
        </div>
        <ResultBanner result={bombPlacementResult} />
      </>
    );
  }

  if (round > 1 && role === "mastermind") {
    const bothPicked = !!selectedSwapRealOptionId && !!selectedSwapFakeOptionId;
    const samePick = bothPicked && selectedSwapRealOptionId === selectedSwapFakeOptionId;
    return (
      <>
        <span className="ig-pill warn">🎭 สิทธิ์จอมบงการ</span>
        <h1 className="ig-title">สลับตำแหน่งระเบิด</h1>
        <p className="ig-sub">
          เลือกตำแหน่งที่คุณเชื่อว่าเป็น "ระเบิดจริง" ก่อน จากนั้นเลือกตำแหน่งที่เป็น "ระเบิดหลอก" — เซิร์ฟเวอร์จะตรวจเองว่าทั้งสองตำแหน่งมีระเบิดวางอยู่จริงหรือไม่ ถ้าเดาผิดคำสั่งจะไม่สำเร็จ
        </p>
        <div style={{ fontWeight: 600, marginTop: 4, marginBottom: 2 }}>1. ตำแหน่งระเบิดจริง</div>
        {effectiveQuestion.options.map((o) => (
          <OptionRow
            key={`real-${o.optionId}`}
            label={o.text}
            selected={selectedSwapRealOptionId === o.optionId}
            onClick={() => onSelectSwapRealOption(o.optionId)}
          />
        ))}
        <div style={{ fontWeight: 600, marginTop: 10, marginBottom: 2 }}>2. ตำแหน่งระเบิดหลอก</div>
        {effectiveQuestion.options.map((o) => (
          <OptionRow
            key={`fake-${o.optionId}`}
            label={o.text}
            selected={selectedSwapFakeOptionId === o.optionId}
            onClick={() => onSelectSwapFakeOption(o.optionId)}
          />
        ))}
        {samePick && (
          <p className="ig-sub" style={{ color: "var(--night-danger, #c0392b)", marginTop: 6 }}>
            ต้องเลือกสองตำแหน่งที่ไม่ซ้ำกัน
          </p>
        )}
        <button
          className="ig-btn ig-btn-brass"
          style={{ marginTop: 8 }}
          disabled={!bothPicked || samePick}
          onClick={onConfirmSwap}
        >
          สั่งสลับตำแหน่งระเบิด
        </button>
        <ResultBanner result={skillResult} />
      </>
    );
  }

  return (
    <div className="ig-waiting-wrap">
      <div className="ig-pulse-dot" />
      <div className="ig-display" style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
        รอผู้เล่นคนอื่นใช้สกิล...
      </div>
      <p className="ig-sub" style={{ maxWidth: 260, margin: "0 auto" }}>
        บทบาท {ROLES[role].name} ไม่มีสกิลในคืนนี้ ระบบจะพาไปช่วงถัดไปโดยอัตโนมัติเมื่อเวลาหมด
      </p>
    </div>
  );
}

/* ---------------- Day screen ---------------- */

function DayScreen({
  round,
  dayStep,
  role,
  countdown,
  question,
  selectedOptionId,
  onSelectOption,
  answerSubmitted,
  onConfirmAnswer,
  otherPlayers,
  selectedTargetId,
  onSelectTarget,
  voteCast,
  onConfirmVote,
  voteTally,
  onGuardianReveal,
  onChiefReveal,
  skillResult,
}: {
  round: number;
  dayStep: DayStep;
  role: RoleKey;
  countdown: string | null;
  question: { prompt: string; options: { optionId: string; text: string }[] };
  selectedOptionId: string | null;
  onSelectOption: (id: string) => void;
  answerSubmitted: boolean;
  onConfirmAnswer: () => void;
  otherPlayers: PublicPlayerView[];
  selectedTargetId: string | null;
  onSelectTarget: (id: string) => void;
  voteCast: string | null;
  onConfirmVote: () => void;
  voteTally: Record<string, number> | undefined;
  onGuardianReveal: () => void;
  onChiefReveal: () => void;
  skillResult: { ok: boolean; reason?: string; data?: unknown } | null;
}) {
  if (dayStep === "answer") {
    return (
      <>
        <p className="ig-sub">ใช้ชุดคำถามที่ถูกล็อกไว้ตั้งแต่คืนแรก ทุกคนตอบพร้อมกัน (ตอบได้ครั้งเดียวต่อรอบ)</p>
        {countdown && <TimerLabel label={countdown} />}
        <h1 className="ig-title" style={{ fontSize: 18 }}>
          {question.prompt}
        </h1>
        <div style={{ marginTop: 14 }}>
          {question.options.map((o) => (
            <OptionRow
              key={o.optionId}
              label={o.text}
              selected={selectedOptionId === o.optionId}
              onClick={() => onSelectOption(o.optionId)}
              disabled={answerSubmitted}
            />
          ))}
        </div>
        <button
          className="ig-btn ig-btn-primary"
          style={{ marginTop: 10 }}
          disabled={!selectedOptionId || answerSubmitted}
          onClick={onConfirmAnswer}
        >
          {answerSubmitted ? "ส่งคำตอบแล้ว รอรอบถัดไป" : "ยืนยันคำตอบ"}
        </button>
      </>
    );
  }

  if (dayStep === "discuss") {
    return (
      <>
        {countdown && <TimerLabel label={countdown} />}
        <p className="ig-sub" style={{ textAlign: "center" }}>
          พูดคุยหารือกันในห้องก่อนโหวต ใครน่าสงสัยว่าเกี่ยวข้องกับระเบิดบ้าง?
        </p>
        {role === "villagehead" && (
          <div className="ig-card">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>🏘️ สิทธิ์ผู้ใหญ่บ้าน</div>
            <p className="ig-sub" style={{ marginBottom: 10 }}>
              เปิดเผยบทบาทตอนนี้เพื่อรู้ตำแหน่งระเบิด — คะแนนโหวตจะเหลือ 1 (จากปกติ 3)
            </p>
            <button className="ig-btn ig-btn-brass" onClick={onChiefReveal}>
              เปิดเผยบทบาทเพื่อรู้ตำแหน่งระเบิด
            </button>
            <ResultBanner result={skillResult} />
          </div>
        )}
      </>
    );
  }

  // vote
  const totalWeight = Object.values(voteTally ?? {}).reduce((a, b) => a + b, 0);
  return (
    <>
      {countdown && <TimerLabel label={countdown} />}
      <p className="ig-sub">โหวตผู้เล่นที่คุณสงสัย — เซิร์ฟเวอร์เช็คเงื่อนไขเอกฉันท์ให้เอง</p>
      <PlayerPicker players={otherPlayers} selectedId={selectedTargetId} onSelect={onSelectTarget} />
      <button
        className="ig-btn ig-btn-primary"
        style={{ marginTop: 8 }}
        disabled={!selectedTargetId || !!voteCast}
        onClick={onConfirmVote}
      >
        {voteCast ? "โหวตแล้ว" : "ยืนยันโหวต"}
      </button>
      {role === "protector" && (
        <div className="ig-card">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>🛡️ สิทธิ์ผู้ปกป้อง (ใช้ได้ 1 ครั้ง/เกม)</div>
          <p className="ig-sub" style={{ marginBottom: 10 }}>
            เปิดเผยบทบาทก่อนสรุปผล เพื่อล้างผลโหวตรอบนี้
          </p>
          <button className="ig-btn ig-btn-brass" onClick={onGuardianReveal}>
            เปิดเผยบทบาท ยกเลิกผลโหวตรอบนี้
          </button>
          <ResultBanner result={skillResult} />
        </div>
      )}
      {voteTally && Object.keys(voteTally).length > 0 && (
        <div className="ig-card" style={{ marginTop: 4 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>ผลโหวตปัจจุบัน (จริงจากเซิร์ฟเวอร์)</div>
          {Object.entries(voteTally).map(([targetId, weight]) => {
            const target = otherPlayers.find((p) => p.playerId === targetId);
            return (
              <div className="ig-result-row" key={targetId}>
                <span>{target?.displayName ?? targetId}</span>
                <span>
                  {weight} คะแนน ({totalWeight ? Math.round((weight / totalWeight) * 100) : 0}%)
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function TimerLabel({ label }: { label: string }) {
  return (
    <div className="ig-timer-ring">
      <div className="ig-timer-num">{label}</div>
    </div>
  );
}

/* ---------------- End screen ---------------- */

function EndScreen({
  result,
  onLeave,
}: {
  result: { winningFaction: string; players: { playerId: string; displayName: string; role: string | null; faction: string | null }[] } | undefined;
  onLeave: () => void;
}) {
  if (!result) {
    return (
      <>
        <p className="ig-sub">เกมจบแล้ว แต่ยังไม่ได้รับข้อมูลสรุปผลจากเซิร์ฟเวอร์</p>
        <button className="ig-btn ig-btn-primary" onClick={onLeave}>
          กลับหน้าแรก
        </button>
      </>
    );
  }

  const factionLabel: Record<string, string> = {
    VILLAGER: "ฝ่ายชาวบ้านชนะ!",
    BOMBER: "ฝ่ายมือวางระเบิดชนะ!",
    FOOL: "คนบ้าชนะ!",
  };
  const factionIcon: Record<string, string> = { VILLAGER: "🌾", BOMBER: "💣", FOOL: "🃏" };

  return (
    <>
      <div className="ig-winner-banner villagers-win">
        <div style={{ fontSize: 34, marginBottom: 6 }}>{factionIcon[result.winningFaction] ?? "🏁"}</div>
        <div className="ig-winner-title">{factionLabel[result.winningFaction] ?? result.winningFaction}</div>
      </div>
      <div className="ig-card">
        {result.players.map((p) => (
          <div className="ig-result-row" key={p.playerId}>
            <span>{p.displayName}</span>
            <span>{p.role ?? "ไม่ทราบบทบาท"}</span>
          </div>
        ))}
      </div>
      <button className="ig-btn ig-btn-primary" onClick={onLeave}>
        ออกจากห้อง
      </button>
    </>
  );
}
