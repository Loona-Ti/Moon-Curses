import { FC } from "react";

// Moon Curses logo: the crescent moon (tinted with the theme's text color) and the name.
const Logo: FC = () => {
  return <span className="inline-flex items-center gap-[0.3em] whitespace-nowrap leading-none">
    <span
      aria-hidden="true"
      className="bg-current inline-block"
      style={{
        height: "1em",
        width: "1em",
        WebkitMaskImage: "url(/images/moon.png)",
        maskImage: "url(/images/moon.png)",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
    <span className="font-header font-black tracking-tight">Moon Curses</span>
  </span>
}

export default Logo;
