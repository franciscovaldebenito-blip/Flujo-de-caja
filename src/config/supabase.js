import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('⚠️ Faltan las variables SUPABASE_URL o SUPABASE_ANON_KEY en el archivo .env');
}

// Asegúrate de que lleve la palabra 'export' al inicio:
export const supabase = createClient(supabaseUrl, supabaseKey);