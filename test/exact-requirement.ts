import { loadConfig } from "../src/config.js";
import { SupabaseService } from "../src/services/supabase.js";

const supabase = new SupabaseService(loadConfig());
const found = await supabase.getRequirement("TRX-REF-001");
if (!found) throw new Error("TRX-REF-001 was not found");
console.log(`Exact requirement: ${found.requirementId}, chunks: ${found.chunks.length}, source: ${found.source}`);

const missing = await supabase.getRequirement("NONEXISTENT-999");
if (missing !== null) throw new Error("NONEXISTENT-999 unexpectedly returned a result");
console.log("Missing requirement: NONEXISTENT-999 not found");