import logoUrl from "../assets/lirrly-logo.png";

/** The Lirrly logo — the v9 app icon, the same one the Dock, the website and
 *  the App Store show — rounded the way macOS rounds an app icon. */
export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ display: "block", borderRadius: Math.round(size * 0.225) }}
    />
  );
}
