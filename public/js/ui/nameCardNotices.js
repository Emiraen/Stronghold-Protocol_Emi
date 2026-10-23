import { useEffect, useState } from '../../vendor/hooks.module.js';
import { isSpecialNameCard } from '../../../shared/nameCards.js';
import { loadPref, savePref } from '../store.js';

// Existing collections form the first baseline; these newly introduced rewards are still new.
export const NEW_RANK_CARD_IDS = Object.freeze(['solari', 'lunari', 'amari', 'terrari', 'evori']
  .map(name => `special_evori_${name}`));
const listeners = new Set();
const memory = new Map();
const uniqueCards = values => [...new Set((Array.isArray(values) ? values : []).filter(isSpecialNameCard))];

/** Permanent unlocks only: locked catalog entries never enter the observed/notification lists. */
export function nextNameCardNotice(previous, acquired, viewed = false) {
  const owned = uniqueCards(acquired);
  const known = previous?.v === 1 ? uniqueCards(previous.observed) : owned.filter(id => !NEW_RANK_CARD_IDS.includes(id));
  const newlyAcquired = owned.filter(id => !known.includes(id));
  const unread = viewed ? [] : uniqueCards([...(previous?.v === 1 ? uniqueCards(previous.unread) : []), ...newlyAcquired])
    .filter(id => owned.includes(id));
  return { v: 1, observed: uniqueCards([...known, ...owned]), unread };
}

/** The rank payload must belong to the same canonical account as the presentation. */
export function updateNameCardNotice(profileId, rank, viewed = false) {
  if (!/^[0-9a-f]{32}$/.test(profileId || '') || rank?.profileId !== profileId
    || !Array.isArray(rank.unlockedNameCards)) return null;
  const key = `nameCards.notice.${profileId}`;
  const previous = memory.get(profileId) || loadPref(key, null);
  const record = nextNameCardNotice(previous, rank.unlockedNameCards, viewed);
  memory.set(profileId, record);
  if (JSON.stringify(record) !== JSON.stringify(previous)) {
    savePref(key, record);
    for (const listener of listeners) listener({ profileId, ...record });
  }
  return { profileId, ...record };
}

/** Shared by the lobby badge and card picker, including a picker opened in a room. */
export function useNameCardNotice(profileId, rank, viewed = false) {
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    const onChange = next => { if (next.profileId === profileId) setNotice(next); };
    listeners.add(onChange);
    setNotice(updateNameCardNotice(profileId, rank, viewed));
    return () => listeners.delete(onChange);
  }, [profileId, rank, viewed]);
  return notice?.profileId === profileId ? notice.unread.length > 0 : false;
}
