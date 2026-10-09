// Phones are sent from the desktop shell to the /m mobile app. "Open the full
// desktop app" (/m More) sets this flag so the redirect lets them through;
// "Back to mobile app" (desktop shell) clears it.
// ponytail: sessionStorage, so the choice lasts until the tab / installed app
// is closed and a desktop link opened in a new tab lands on /m again. Move to
// localStorage if people want the choice remembered.
const KEY = "hookka.preferDesktop";

const PHONE_UA = /Android|iPhone|iPod|Mobile/i;

/** True for phone-class browsers (iPad reports a desktop UA and stays out). */
export function isPhoneUa(ua: string): boolean {
  return PHONE_UA.test(ua);
}

/** The desktop shell's gate: phones go to /m unless they chose desktop. */
export function shouldRedirectToMobile(ua: string, preferDesktop: boolean): boolean {
  return isPhoneUa(ua) && !preferDesktop;
}

export function prefersDesktop(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setPreferDesktop(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(KEY, "1");
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the phone simply stays on /m */
  }
}
