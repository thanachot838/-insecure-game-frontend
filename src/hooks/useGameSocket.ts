import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

// Requires the `socket.io-client` package — add it if it isn't already
// in package.json: npm install socket.io-client

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL as string;

// ---- Shapes mirrored by hand from backend/src/game/serialize.ts + types.ts ----
// If the backend adds/changes fields on PublicRoomView / PrivatePlayerView,
// update these to match.

export type GamePhase =
  | "LOBBY"
  | "NIGHT_1"
  | "DAY_ANSWER"
  | "DAY_DISCUSSION"
  | "DAY_VOTE"
  | "NIGHT"
  | "ENDED";

export interface PublicPlayerView {
  playerId: string;
  displayName: string;
  connected: boolean;
  votePower: number;
}

export interface PrivatePlayerView extends PublicPlayerView {
  role: string | null; // backend RoleName, e.g. "BOMBER" — see ROLE_NAME_TO_KEY in GameFlowDemo.tsx
  faction: string | null;
  foolTokens: number;
}

export interface RoomResultView {
  winningFaction: string;
  players: { playerId: string; displayName: string; role: string | null; faction: string | null }[];
}

export interface PublicRoomView {
  roomId: string;
  phase: GamePhase;
  round: number;
  players: PublicPlayerView[];
  serverTimeMs: number;
  phaseEndsAtMs: number | null;
  voteTally?: Record<string, number>;
  result?: RoomResultView;
  lockedQuestion?: PublicLockedQuestion | null;
}

export type ActionResult = { ok: boolean; reason?: string; data?: unknown };

export interface PublicLockedQuestion {
  questionId: string;
  prompt: string;
  options: { optionId: string; text: string }[];
}

const SESSION_KEY_PREFIX = "insecure_game_session:";

export function useGameSocket() {
  const socketRef = useRef<Socket | null>(null);
  const pendingRoomIdRef = useRef<string | null>(null);

  const [connected, setConnected] = useState(false);
  const [roomState, setRoomState] = useState<PublicRoomView | null>(null);
  const [privateState, setPrivateState] = useState<PrivatePlayerView | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);

  useEffect(() => {
    const socket = io(BACKEND_URL, { autoConnect: false });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("room:state", (view: PublicRoomView) => setRoomState(view));
    socket.on("player:private_state", (view: PrivatePlayerView) => setPrivateState(view));

    socket.on("room:joined", ({ sessionToken, playerId }: { sessionToken: string; playerId: string }) => {
      setJoinError(null);
      setMyPlayerId(playerId);
      // Persisted so a refresh/reconnect restores the SAME player instead of
      // spawning a new one — see backend rule [3.1] in sockets/index.ts.
      const roomId = pendingRoomIdRef.current;
      if (roomId) sessionStorage.setItem(SESSION_KEY_PREFIX + roomId, sessionToken);
    });

    socket.on("room:error", ({ reason }: { reason: string }) => {
      setJoinError(reason);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  /**
   * `accessToken` (the caller's Supabase access token, if logged in) is optional
   * and only matters for whoever created the room — see backend rule fix in
   * sockets/index.ts room:join: the server verifies this token itself and only
   * treats the connection as "the host" if the verified user id matches
   * room.settings.hostId. Regular joiners can safely omit it (or pass null),
   * matching the product rule that joining never requires an account.
   */
  const joinRoom = useCallback((roomId: string, displayName: string, accessToken?: string | null) => {
    const socket = socketRef.current;
    if (!socket) return;
    pendingRoomIdRef.current = roomId;
    setJoinError(null);
    if (!socket.connected) socket.connect();
    const sessionToken = sessionStorage.getItem(SESSION_KEY_PREFIX + roomId) ?? undefined;
    socket.emit("room:join", { roomId, displayName, sessionToken, accessToken: accessToken ?? undefined });
  }, []);

  const leaveRoom = useCallback(() => {
    socketRef.current?.disconnect();
    pendingRoomIdRef.current = null;
    setRoomState(null);
    setPrivateState(null);
    setMyPlayerId(null);
    setJoinError(null);
  }, []);

  /** Emits an event and resolves with its `<event>:result` reply. */
  const emitWithResult = useCallback(<T extends ActionResult = ActionResult>(
    event: string,
    payload: unknown
  ): Promise<T> => {
    return new Promise((resolve) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected) {
        resolve({ ok: false, reason: "not_connected" } as T);
        return;
      }
      socket.once(`${event}:result`, (result: T) => resolve(result));
      socket.emit(event, payload);
    });
  }, []);

  const startGame = useCallback(() => emitWithResult("game:start", {}), [emitWithResult]);

  /** Real question sets the Host authored via POST /api/questions/:roomId — replaces the
   *  frontend's local gameData.ts mock. Any player already in the room can call this
   *  (no login required), matching game:list_question_sets on the backend. */
  const listQuestionSets = useCallback(
    () => emitWithResult<{ ok: boolean; reason?: string; data?: PublicLockedQuestion[] }>("game:list_question_sets", {}),
    [emitWithResult]
  );

  const lockQuestionSet = useCallback(
    (questionSetId: string) => emitWithResult("game:lock_question_set", { questionSetId }),
    [emitWithResult]
  );

  const submitAnswer = useCallback(
    (optionId: string) => emitWithResult("game:submit_answer", { optionId }),
    [emitWithResult]
  );

  const castVote = useCallback(
    (targetId: string) => emitWithResult("game:vote", { targetId }),
    [emitWithResult]
  );

  const useSkill = useCallback(
    (payload: {
      skill: string;
      targetPlayerId?: string;
      optionId?: string;
      realOptionId?: string;
      fakeOptionId?: string;
    }) => emitWithResult("game:use_skill", payload),
    [emitWithResult]
  );

  return {
    connected,
    roomState,
    privateState,
    joinError,
    myPlayerId,
    joinRoom,
    leaveRoom,
    startGame,
    listQuestionSets,
    lockQuestionSet,
    submitAnswer,
    castVote,
    useSkill,
  };
}
