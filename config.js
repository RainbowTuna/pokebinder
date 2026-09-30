// Supabase project for login + cloud sync.
// The publishable key is meant to be public – Row Level Security (see supabase-setup.sql)
// is what keeps each person's binders private.
export const SUPABASE_URL = 'https://bthobaomqmsvqabjtxvj.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_1ZPY9L3klLzirtnFV3HDIw_IY72ecka';

// Picture relay for the scanner's picture check (supabase/functions/card-image).
export const CARD_IMAGE_RELAY = `${SUPABASE_URL}/functions/v1/card-image`;
