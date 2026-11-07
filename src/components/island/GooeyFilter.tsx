/* Kegunaan: Komponen SVG filter tersembunyi untuk memberikan efek cair (teardrop gooey).
 */

import React from "react";

export const GooeyFilter: React.FC = () => {
  return (
    <svg className="absolute w-0 h-0 overflow-hidden" aria-hidden="true">
      <defs>
        <filter
          id="gooey-effect"
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
          <feColorMatrix
            in="blur"
            mode="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -9"
            result="gooey"
          />
          <feComposite in="SourceGraphic" in2="gooey" operator="over" />
        </filter>
      </defs>
    </svg>
  );
};
