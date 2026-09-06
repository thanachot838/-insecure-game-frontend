// Demo/mock data for the UI-flow prototype.
// In the real app these come from the server (see backend `game/types.ts`,
// `routes/questions.ts`, and the `room:state` / `player:private_state` socket events) —
// this file only exists so the UI can be clicked through standalone for design review.

export type Faction = "villagers" | "bombers";

export interface RoleInfo {
  name: string;
  icon: string;
  faction: Faction;
  desc: string;
}

export type RoleKey =
  | "villager"
  | "wiseman"
  | "seer"
  | "protector"
  | "villagehead"
  | "fool"
  | "bomber"
  | "mastermind";

export const ROLES: Record<RoleKey, RoleInfo> = {
  villager: {
    name: "ชาวบ้าน",
    icon: "🌾",
    faction: "villagers",
    desc: "เลือกยึดโยงผู้เล่น 1 คนในคืนแรก โดยไม่ทราบฝ่ายหรือชื่อ",
  },
  wiseman: {
    name: "ผู้มีปัญญา",
    icon: "🔍",
    faction: "villagers",
    desc: "ตรวจสอบฝ่าย (คืนแรก) หรือฝ่าย+บทบาท (คืนถัดไป) ของผู้เล่น 1 คน",
  },
  seer: {
    name: "ผู้หยั่งรู้",
    icon: "👁️",
    faction: "villagers",
    desc: "เลือกคำถาม 1 ข้อ เพื่อตรวจสอบว่าเสี่ยงหรือปลอดภัยจากระเบิด",
  },
  protector: {
    name: "ผู้ปกป้อง",
    icon: "🛡️",
    faction: "villagers",
    desc: "เปิดเผยบทบาทก่อนสรุปโหวตเพื่อล้างผลโหวตและเก็บระเบิดออก (ใช้ได้ 1 ครั้ง)",
  },
  villagehead: {
    name: "ผู้ใหญ่บ้าน",
    icon: "🏘️",
    faction: "villagers",
    desc: "มีคะแนนโหวต 3 คะแนน หรือเปิดเผยบทบาทเพื่อรู้ตำแหน่งระเบิด (เหลือโหวต 1)",
  },
  fool: {
    name: "คนบ้า",
    icon: "🃏",
    faction: "villagers",
    desc: "ชนะทันทีหากผลโหวตเอกฉันท์ 0-11/11-0 หรือสะสมครบ 3 เข็ม",
  },
  bomber: {
    name: "นักวางระเบิด",
    icon: "💣",
    faction: "bombers",
    desc: "เลือกล็อกชุดคำถามคืนแรก ถือระเบิด 3 ลูก วางระเบิดหลอกได้ในคืนถัดไป",
  },
  mastermind: {
    name: "จอมบงการ",
    icon: "🎭",
    faction: "bombers",
    desc: "สั่งสลับตำแหน่งระเบิดจริง/หลอก หลังผู้หยั่งรู้สืบข้อมูลแล้ว",
  },
};

export const FACTION_LABEL: Record<Faction, string> = {
  villagers: "ฝ่ายชาวบ้าน",
  bombers: "ฝ่ายมือวางระเบิด",
};

export const PLAYERS = [
  "คุณ",
  "มายด์",
  "บาส",
  "แนน",
  "ต้น",
  "ฟ้า",
  "กอล์ฟ",
  "ปลา",
  "เอิร์ธ",
  "ไอซ์",
];

export interface QuestionSet {
  id: number;
  name: string;
  q: string;
  opts: string[];
}

export const QUESTION_SETS: QuestionSet[] = [
  {
    id: 1,
    name: "ชุด: ทั่วไป",
    q: "เมืองหลวงของประเทศฝรั่งเศสคือเมืองอะไร?",
    opts: ["ปารีส", "ลียง", "มาร์กเซย", "นีซ"],
  },
  {
    id: 2,
    name: "ชุด: วิทยาศาสตร์",
    q: "ดาวเคราะห์ดวงใดใกล้ดวงอาทิตย์ที่สุด?",
    opts: ["ดาวศุกร์", "ดาวพุธ", "ดาวอังคาร", "โลก"],
  },
  {
    id: 3,
    name: "ชุด: บันเทิง",
    q: "ภาพยนตร์เรื่องใดได้รางวัลออสการ์ปี 2024?",
    opts: ["Oppenheimer", "Barbie", "Poor Things", "Dune"],
  },
];

export const SCREEN_SEQUENCE = [
  "lobby",
  "reveal",
  "night1",
  "day1a",
  "day1b",
  "day1c",
  "night2",
  "day2a",
  "day2b",
  "day2c",
  "night3",
  "day3a",
  "day3b",
  "day3c",
  "end",
] as const;

export type SeqStep = (typeof SCREEN_SEQUENCE)[number];
