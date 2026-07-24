import "dotenv/config";
import { analyzeReport } from "./analyze.js";

const code = process.argv[2];
const result = await analyzeReport(code);
console.log(JSON.stringify(result, null, 2));
