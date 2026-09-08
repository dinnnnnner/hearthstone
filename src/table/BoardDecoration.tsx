export function BoardDecoration() {
  return (
    <svg
      className="board-decoration"
      viewBox="0 0 1200 720"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <pattern
          id="woodgrain"
          width="210"
          height="73"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M0 2h210M0 69h210"
            stroke="#3e201b"
            strokeOpacity=".3"
            strokeWidth="2"
          />
          <path
            d="M0 12c70-10 110 9 210-3M0 48c90-14 130 8 210 0M20 30c50 5 80-10 160-4M60 56c30-8 50-3 80-5"
            fill="none"
            stroke="#a77248"
            strokeOpacity=".16"
          />
          <ellipse
            cx="158"
            cy="20"
            rx="20"
            ry="3"
            stroke="#4b2e23"
            strokeOpacity=".22"
            fill="none"
          />
        </pattern>
        <linearGradient id="boardlight" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#b98754" />
          <stop offset=".55" stopColor="#cba775" />
          <stop offset="1" stopColor="#946644" />
        </linearGradient>
      </defs>
      <path
        d="M24 24Q150 2 270 25L460 15Q600 60 740 15L930 25Q1050 2 1176 24L1160 210L1180 240L1160 430L1178 480L1152 682L788 680Q600 604 412 680L48 682L22 480L40 430L20 240L40 210Z"
        fill="url(#boardlight)"
        stroke="#4c3327"
        strokeWidth="12"
      />
      <path
        d="M24 24Q150 2 270 25L460 15Q600 60 740 15L930 25Q1050 2 1176 24L1160 210L1180 240L1160 430L1178 480L1152 682L788 680Q600 604 412 680L48 682L22 480L40 430L20 240L40 210Z"
        fill="url(#woodgrain)"
        stroke="#d0af74"
        strokeWidth="3"
      />
      <path
        d="M44 44 220 44 202 62 66 64 78 172 52 198ZM1156 44 980 44 998 62 1134 64 1122 172 1148 198Z"
        fill="#594033"
        stroke="#ad864d"
        strokeWidth="3"
      />
      <g fill="none" stroke="#9a703f" strokeWidth="3" opacity=".7">
        <path d="m88 90 52-6 20-15h54m-128 34 75-5 18-18h38M1112 90l-52-6-20-15h-54m128 34-75-5-18-18h-38" />
        <path d="M82 607h213l62 22H80v-47m1038 25H905l-62 22h277v-47" />
      </g>
      <path
        d="M52 506Q266 529 447 606L411 659H61Z"
        fill="#3b3747"
        stroke="#776759"
        strokeWidth="5"
      />
      <path
        d="M1148 506Q934 529 753 606L789 659h350Z"
        fill="#3b3747"
        stroke="#776759"
        strokeWidth="5"
      />
      <g fill="none" stroke="#726072" strokeOpacity=".5" strokeWidth="2">
        <path d="M75 536q185 14 333 79M77 550q170 15 309 71M80 567q120 4 240 57M1125 536q-185 14-333 79M1123 550q-170 15-309 71M1120 567q-120 4-240 57" />
      </g>
      <path
        d="M32 344Q600 354 1168 344"
        stroke="#7b5839"
        strokeOpacity=".16"
        strokeWidth="2"
      />
    </svg>
  );
}
