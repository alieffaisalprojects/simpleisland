import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { SkyPhase } from "./prayer";

export const FORCE_PHASE: SkyPhase | null = null;

export type SkyWeather = "clear" | "cloudy" | "rain" | "thunderstorm";

interface Theme {
  sky: string;
  horizon: string;
  sun: string;
  sunPosition: { x: number; y: number };
  moon: boolean;
  stars: number;
  cloudColor: string;
  cloudOpacity: number;
}

const THEMES: Record<SkyPhase, Theme> = {
  night: {
    sky: "linear-gradient(180deg, #080d20 0%, #111c38 52%, #263653 100%)",
    horizon: "rgba(75, 103, 151, 0.12)",
    sun: "rgba(190, 207, 255, 0.8)",
    sunPosition: { x: 82, y: 25 },
    moon: true,
    stars: 1,
    cloudColor: "#aab9d6",
    cloudOpacity: 0.2,
  },
  dawn: {
    sky: "linear-gradient(180deg, #202c58 0%, #665b8d 48%, #d28e91 78%, #f5b99b 100%)",
    horizon: "rgba(255, 177, 143, 0.38)",
    sun: "rgba(255, 197, 150, 0.95)",
    sunPosition: { x: 78, y: 88 },
    moon: false,
    stars: 0.35,
    cloudColor: "#f4c8bd",
    cloudOpacity: 0.42,
  },
  morning: {
    sky: "linear-gradient(180deg, #3679b9 0%, #75b4df 58%, #c4dff0 100%)",
    horizon: "rgba(255, 231, 195, 0.2)",
    sun: "rgba(255, 245, 211, 0.95)",
    sunPosition: { x: 82, y: 22 },
    moon: false,
    stars: 0,
    cloudColor: "#ffffff",
    cloudOpacity: 0.72,
  },
  noon: {
    sky: "linear-gradient(180deg, #2872c5 0%, #5ba1d9 58%, #a9d4ec 100%)",
    horizon: "rgba(255, 255, 255, 0.12)",
    sun: "rgba(255, 250, 226, 1)",
    sunPosition: { x: 80, y: 10 },
    moon: false,
    stars: 0,
    cloudColor: "#ffffff",
    cloudOpacity: 0.7,
  },
  afternoon: {
    sky: "linear-gradient(180deg, #405e91 0%, #b77e72 58%, #efb58c 100%)",
    horizon: "rgba(255, 192, 133, 0.3)",
    sun: "rgba(255, 205, 148, 0.95)",
    sunPosition: { x: 80, y: 58 },
    moon: false,
    stars: 0,
    cloudColor: "#f5d5c3",
    cloudOpacity: 0.5,
  },
  dusk: {
    sky: "linear-gradient(180deg, #201b48 0%, #69416f 48%, #c46b75 82%, #edaa83 100%)",
    horizon: "rgba(255, 142, 112, 0.35)",
    sun: "rgba(255, 143, 119, 0.9)",
    sunPosition: { x: 80, y: 91 },
    moon: false,
    stars: 0.55,
    cloudColor: "#e8b1c1",
    cloudOpacity: 0.4,
  },
};

const STARS = Array.from({ length: 42 }, (_, i) => {
  const seed = (i * 127.1 + 311.7) % 97;
  return {
    x: (seed * 13.7) % 100,
    y: (seed * 7.3) % 65,
    size: 1 + ((seed * 3.1) % 1.6),
    delay: -((seed * 2.7) % 5),
    duration: 2.5 + ((seed * 1.9) % 3),
  };
});

const CLOUDS = [
  { x: -12, y: 17, scale: 1.1, duration: 75, delay: -30 },
  { x: 47, y: 35, scale: 0.78, duration: 92, delay: -55 },
  { x: 12, y: 58, scale: 1.35, duration: 110, delay: -70 },
  { x: 76, y: 13, scale: 0.65, duration: 85, delay: -20 },
];

const RAIN = Array.from({ length: 65 }, (_, i) => ({
  x: (i * 37.7) % 105,
  y: (i * 19.3) % 100,
  duration: 0.65 + ((i * 13) % 8) * 0.08,
  delay: -((i * 17) % 30) / 10,
  length: 12 + ((i * 7) % 13),
  opacity: 0.16 + ((i * 11) % 5) * 0.055,
}));

const CSS = `
@keyframes sky-star {
  0%, 100% { opacity: .25; transform: scale(.8); }
  50% { opacity: 1; transform: scale(1.2); }
}

@keyframes sky-cloud-drift {
  from { transform: translateX(-35px); }
  to { transform: translateX(35px); }
}

@keyframes sky-sun-pulse {
  0%, 100% { transform: scale(1); opacity: .85; }
  50% { transform: scale(1.08); opacity: 1; }
}

@keyframes sky-rain-fall {
  from { transform: translate3d(0, -30px, 0); }
  to { transform: translate3d(-24px, 110vh, 0); }
}

@keyframes sky-lightning {
  0%, 92%, 96%, 100% { opacity: 0; }
  93%, 95% { opacity: .8; }
  94% { opacity: .15; }
}

@keyframes sky-fog {
  0%, 100% { transform: translateX(-3%); opacity: .16; }
  50% { transform: translateX(3%); opacity: .3; }
}

@media (prefers-reduced-motion: reduce) {
  .sky-motion { animation: none !important; }
}
`;

const Cloud: React.FC<{
  color: string;
  opacity: number;
  scale?: number;
}> = ({ color, opacity, scale = 1 }) => (
  <svg
    viewBox="0 0 300 110"
    width={300 * scale}
    height={110 * scale}
    style={{
      overflow: "visible",
      opacity,
      filter: "blur(1.5px)",
    }}
  >
    <defs>
      <linearGradient id="sky-cloud-gradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#ffffff" stopOpacity=".95" />
        <stop offset="100%" stopColor={color} stopOpacity=".72" />
      </linearGradient>
    </defs>
    <path
      d="M48 87 C18 87 10 65 23 47 C33 32 49 30 65 35 C72 9 101 0 124 15 C139 25 144 39 143 46 C166 19 205 24 217 48 C244 39 273 52 274 73 C275 89 259 97 239 97 H52 Z"
      fill="url(#sky-cloud-gradient)"
    />
    <path
      d="M30 75 C45 56 66 55 83 61 C105 31 142 38 157 59 C177 40 205 46 218 65"
      fill="none"
      stroke="#ffffff"
      strokeOpacity=".22"
      strokeWidth="5"
      strokeLinecap="round"
    />
  </svg>
);

const WeatherClouds: React.FC<{
  theme: Theme;
  weather: SkyWeather;
}> = ({ theme, weather }) => {
  const count = weather === "clear" ? 2 : weather === "cloudy" ? 4 : 5;

  return (
    <div className="absolute inset-0 overflow-hidden">
      {CLOUDS.slice(0, count).map((cloud, i) => (
        <motion.div
          key={i}
          className="absolute"
          style={{
            left: `${cloud.x}%`,
            top: `${cloud.y}%`,
          }}
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 1.8, delay: i * 0.12 }}
        >
          <div
            className="sky-motion"
            style={{
              animation: `sky-cloud-drift ${cloud.duration}s ease-in-out ${cloud.delay}s infinite alternate`,
            }}
          >
            <Cloud
              color={
                weather === "rain" || weather === "thunderstorm"
                  ? "#64748b"
                  : theme.cloudColor
              }
              opacity={
                weather === "clear"
                  ? theme.cloudOpacity * 0.5
                  : weather === "cloudy"
                    ? 0.78
                    : 0.88
              }
              scale={cloud.scale}
            />
          </div>
        </motion.div>
      ))}
    </div>
  );
};

const RainLayer: React.FC<{ heavy?: boolean }> = ({ heavy = false }) => (
  <div className="absolute inset-0 overflow-hidden pointer-events-none">
    {RAIN.map((drop, i) => (
      <span
        key={i}
        className="sky-motion absolute"
        style={{
          left: `${drop.x}%`,
          top: `${drop.y}%`,
          width: heavy ? 1.5 : 1,
          height: drop.length * (heavy ? 1.3 : 1),
          borderRadius: 10,
          background:
            "linear-gradient(180deg, transparent, rgba(224,240,255,.8))",
          opacity: drop.opacity * (heavy ? 1.4 : 1),
          transform: "rotate(16deg)",
          animation: `sky-rain-fall ${drop.duration * (heavy ? 0.75 : 1)}s linear ${drop.delay}s infinite`,
          willChange: "transform",
        }}
      />
    ))}
    <div
      className="absolute inset-0"
      style={{
        background:
          "linear-gradient(180deg, rgba(12,28,48,.08), rgba(12,28,48,.18))",
      }}
    />
  </div>
);

const SkyScene: React.FC<{
  phase: SkyPhase;
  weather: SkyWeather;
}> = ({ phase, weather }) => {
  const theme = THEMES[phase];
  const isRain = weather === "rain" || weather === "thunderstorm";
  const isStorm = weather === "thunderstorm";
  const isCloudy = weather !== "clear";

  return (
    <>
      <div
        className="absolute inset-0 transition-colors duration-1000"
        style={{
          background: isStorm
            ? "linear-gradient(180deg, #101b2c 0%, #26384b 55%, #405366 100%)"
            : isRain
              ? "linear-gradient(180deg, #26394d 0%, #526b7e 58%, #8396a2 100%)"
              : isCloudy
                ? "linear-gradient(180deg, #526a82 0%, #8da1ae 58%, #c1cbd0 100%)"
                : theme.sky,
        }}
      />

      <div
        className="absolute inset-x-0 bottom-0"
        style={{
          height: "65%",
          background: `radial-gradient(ellipse 90% 100% at 50% 100%, ${theme.horizon}, transparent 75%)`,
        }}
      />

      {theme.stars > 0 && !isCloudy && (
        <motion.div
          className="absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: theme.stars }}
          transition={{ duration: 1.5 }}
        >
          {STARS.map((star, i) => (
            <span
              key={i}
              className="sky-motion absolute rounded-full bg-white"
              style={{
                left: `${star.x}%`,
                top: `${star.y}%`,
                width: star.size,
                height: star.size,
                animation: `sky-star ${star.duration}s ease-in-out ${star.delay}s infinite`,
              }}
            />
          ))}
        </motion.div>
      )}

      {!isCloudy && (
        <motion.div
          className="absolute"
          style={{
            left: `${theme.sunPosition.x}%`,
            top: `${theme.sunPosition.y}%`,
            width: 220,
            height: 220,
            marginLeft: -110,
            marginTop: -110,
          }}
          initial={{ opacity: 0, scale: 0.65, y: 55 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 1.8, ease: "easeOut" }}
        >
          <div
            className="sky-motion absolute inset-0 rounded-full"
            style={{
              background: `radial-gradient(circle, ${theme.sun} 0%, ${theme.sun.replace(/[\d.]+\)$/, "0.22)")} 28%, transparent 72%)`,
              animation: "sky-sun-pulse 8s ease-in-out infinite",
            }}
          />
          {theme.moon && (
            <div
              className="absolute rounded-full"
              style={{
                width: 34,
                height: 34,
                top: 92,
                left: 92,
                background: "#e8edff",
                boxShadow: "0 0 35px rgba(201,215,255,.45)",
              }}
            />
          )}
        </motion.div>
      )}

      <WeatherClouds theme={theme} weather={weather} />

      {isRain && <RainLayer heavy={isStorm} />}

      {isStorm && (
        <div
          className="sky-motion absolute inset-0 pointer-events-none"
          style={{
            background: "rgba(220,235,255,.35)",
            opacity: 0,
            animation: "sky-lightning 8s linear 2s infinite",
          }}
        />
      )}

      {isCloudy && (
        <div
          className="sky-motion absolute inset-0 pointer-events-none"
          style={{
            background:
              "linear-gradient(180deg, rgba(13,28,43,.08), rgba(13,28,43,.16))",
          }}
        />
      )}

      <div
        className="sky-motion absolute"
        style={{
          left: "-15%",
          right: "-15%",
          bottom: "5%",
          height: "26%",
          background:
            "radial-gradient(ellipse at center, rgba(220,235,244,.18), transparent 70%)",
          filter: "blur(24px)",
          animation: "sky-fog 18s ease-in-out infinite",
        }}
      />

      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "linear-gradient(90deg, rgba(0,0,0,.16), transparent 75%), linear-gradient(0deg, rgba(0,0,0,.16), transparent 48%)",
        }}
      />
    </>
  );
};

export const PrayerSky: React.FC<{
  phase: SkyPhase;
  weather?: SkyWeather;
}> = ({ phase, weather = "clear" }) => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 overflow-hidden"
  >
    <style>{CSS}</style>

    <AnimatePresence mode="sync">
      <motion.div
        key={`${phase}-${weather}`}
        className="absolute inset-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 1.4 }}
      >
        <SkyScene phase={phase} weather={weather} />
      </motion.div>
    </AnimatePresence>
  </div>
);

export default PrayerSky;
