import type { Work } from "./declaration.js";

/** A model describes each photo in a photo library, so the photos can be searched by what is in them. */
export const LIBRARY_PHOTOS: Work = {
  label: "Photo descriptions", kind: "pictures", noun: ["photo", "photos"],
  about: "A model writes a short description of each photo, so you can search your photos by what is in them.",
};

/** A model describes the photos sent in chats, so they read as text in the days and in search. */
export const CHAT_PHOTOS: Work = {
  label: "Photo descriptions", kind: "pictures", noun: ["photo", "photos"],
  about: "A model describes the photos in your chats, so they read as text in your days and in search.",
};

/** A model transcribes the voice notes sent in chats. */
export const CHAT_VOICE: Work = {
  label: "Voice note transcripts", kind: "audio", noun: ["voice note", "voice notes"],
  about: "A model transcribes your voice notes.",
};

/** A model writes out each voice note the person sends Chat, its audio leaving the machine as it is whatever the privacy level. */
export const ASK_VOICE: Work = {
  label: "Voice notes", kind: "audio", noun: ["voice note", "voice notes"], as_is: true,
  about: "A model writes out each voice note you send Chat.",
};

/** A model transcribes each voice note the person records. */
export const RECORDINGS: Work = {
  label: "Voice note transcripts", kind: "audio", noun: ["voice note", "voice notes"],
  about: "A model transcribes each voice note you record.",
};

/** A model reads each email and writes one line for each automated one, saying what it is and what it says. */
export const MAIL: Work = {
  label: "Email summaries", kind: "text", noun: ["email", "emails"],
  about: "A model reads each email, and writes one line for each automated one: what it is and what it says.",
};

/** A model shortens very long messages in AI chats to a line or two. */
export const AI_CHATS: Work = {
  label: "Chat summaries", kind: "text", noun: ["message", "messages"],
  about: "A model shortens very long messages in your AI chats to a line or two. Short ones are shown as written.",
};

/** A model reads the text on the Mac's screen during one sitting, up to 500,000 characters, and writes what the person was doing. */
export const SCREEN: Work = {
  label: "Screen summaries", kind: "text", noun: ["sitting", "sittings"], text_chars: 500_000,
  about: "A model reads the text that was on your screen during one sitting at your Mac and writes what you were doing.",
};
