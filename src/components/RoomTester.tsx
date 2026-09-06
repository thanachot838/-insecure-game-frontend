import { useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { apiFetch } from "../lib/api";

export function RoomTester() {
  const { accessToken, signOut, session } = useAuth();
  const [result, setResult] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function createRoom() {
    setBusy(true);
    setResult("");
    try {
      const data = await apiFetch("/api/rooms", accessToken, {
        method: "POST",
        body: JSON.stringify({ totalRounds: 3 }),
      });
      setResult(JSON.stringify(data, null, 2));
    } catch (err) {
      setResult(`Error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8, maxWidth: 480 }}>
      <p>เข้าสู่ระบบแล้วในนาม: {session?.user.email}</p>
      <button onClick={createRoom} disabled={busy}>
        {busy ? "กำลังสร้างห้อง..." : "ทดสอบสร้างห้องเกม (POST /api/rooms)"}
      </button>
      <button onClick={() => signOut()}>ออกจากระบบ</button>
      {result && <pre style={{ background: "#f4f4f4", padding: 8 }}>{result}</pre>}
    </div>
  );
}