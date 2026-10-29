    ],
    matchup: "SEA vs CHI",
    fair: 113.5,
    proj: 123.0,
    ciLow: 66,
    ciHigh: 182,
  },
  {
    id: "amon-ra-st-brown",
    pos: "WR",
    initials: "AS",
    name: "Amon-Ra St. Brown",
    team: "DET",
    role: "Featured WR",
    drivers: [{ label: "alpha", value: "33%", type: "alpha" }],
    matchup: "DET vs MIN",
    env: "Dome",
    fair: 90.0,
    proj: 98.2,
    ciLow: 52,
    ciHigh: 145,
  },
  {
    id: "zay-flowers",
    pos: "WR",
    initials: "ZF",
    name: "Zay Flowers",
    team: "BAL",
    role: "Featured WR",
    drivers: [{ label: "alpha", value: "32%", type: "alpha" }],
    matchup: "BAL @ BUF",
    fair: 85.0,
    proj: 93.0,
    ciLow: 49,
    ciHigh: 138,
  },
  {
    id: "jamarr-chase",
    pos: "WR",
    initials: "JC",
    name: "Ja'Marr Chase",
    team: "CIN",
    role: "Featured WR",
    drivers: [{ label: "volume", value: "9.7 tgt", type: "volume" }],
    matchup: "CIN vs TEN",
    fair: 72.5,
    proj: 79.7,
    ciLow: 42,
    ciHigh: 118,
  },
];

export default function PropSteinTerminal2027() {
  const [sport, setSport] = useState<"NFL" | "NBA">("NFL");
  const [mode, setMode] = useState<"ACTIVE" | "TOP" | "ALL">("TOP");
  const [market, setMarket] = useState<"Yards" | "Rec" | "TD">("Yards");
  const [pos, setPos] = useState<"All" | "WR" | "TE" | "RB">("All");
  const [view, setView] = useState<"Table" | "Grid">("Table");
  const [search, setSearch] = useState("");
  const [simulatingId, setSimulatingId] = useState<string | null>(null);
  const [simLine, setSimLine] = useState<string>("");

  return (
    <div className="min-h-screen bg-[#050811] text-slate-100 selection:bg-sky-500/30 selection:text-sky-200">
      {/* Ambient Top Sapphire Radial Glow */}
      <div className="pointer-events-none fixed inset-x-0 -top-40 z-0 mx-auto h-80 max-w-5xl rounded-full bg-sky-500/[0.07] blur-[120px]" />

      {/* 1. TOP APP BAR */}
      <header className="relative z-30 border-b border-white/[0.06] bg-[#050811]/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-6 py-3">
          <div className="flex items-center gap-4">
            <span className="font-mono text-lg font-extrabold tracking-wider text-white italic">
              PROP<span className="text-sky-400">STEIN</span>
            </span>
