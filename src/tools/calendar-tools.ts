import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveInputPath, WORKSPACE_PARAM_DESCRIPTION } from '../utils/workspace';
import { logger } from '../utils/logger';

interface ExtractedEvent {
	year: number;
	month: number;
	day: number;
	endYear?: number;
	endMonth?: number;
	endDay?: number;
	allDay: boolean;
	title: string;
	sourceLine: string;
}

const MONTHS_FR: Array<[RegExp, number]> = [
	[/^(janvier|janv\.?)$/i, 1], [/^(février|fevrier|févr\.?|fevr\.?)$/i, 2],
	[/^(mars|mar\.?)$/i, 3], [/^(avril|avr\.?)$/i, 4],
	[/^(mai)$/i, 5], [/^(juin|jun\.?)$/i, 6],
	[/^(juillet|juil\.?|jul\.?)$/i, 7], [/^(août|aout|aug\.?)$/i, 8],
	[/^(septembre|sept\.?|sep\.?)$/i, 9], [/^(octobre|oct\.?)$/i, 10],
	[/^(novembre|nov\.?)$/i, 11], [/^(décembre|decembre|déc\.?|dec\.?)$/i, 12],
];
const MONTHS_EN: Array<[RegExp, number]> = [
	[/^jan(uary)?\.?$/i, 1], [/^feb(ruary)?\.?$/i, 2], [/^mar(ch)?\.?$/i, 3],
	[/^apr(il)?\.?$/i, 4], [/^may$/i, 5], [/^jun(e)?\.?$/i, 6],
	[/^jul(y)?\.?$/i, 7], [/^aug(ust)?\.?$/i, 8], [/^sep(t(ember)?)?\.?$/i, 9],
	[/^oct(ober)?\.?$/i, 10], [/^nov(ember)?\.?$/i, 11], [/^dec(ember)?\.?$/i, 12],
];

const KEYWORDS = [
	'congé', 'congés', 'vacances', 'vacance', 'holiday', 'holidays', 'exam',
	'examen', 'examens', 'rentree', 'rentrée', 'stage', 'réunion', 'reunion',
	'meeting', 'deadline', 'échéance', 'echeance', 'rendez-vous', 'rdv',
	'cours', 'fermé', 'ferme', 'closed', 'off', 'sortie', 'sortie scolaire',
	'conseil', 'classe', 'inscriptions', 'photo', 'carnival', 'carnaval',
	'noël', 'noel', 'christmas', 'paques', 'pâques', 'easter', 'toussaint',
	'ascension', 'pentecote', 'pentecôte', 'fete', 'fête', 'national',
	'travail', 'victoire', 'armistice', 'assomption', 'halloween', 'saint',
];

function monthFromName(word: string): number | undefined {
	const w = word.trim().replace(/\.$/, '');
	for (const [re, num] of MONTHS_FR) if (re.test(w)) return num;
	for (const [re, num] of MONTHS_EN) if (re.test(w)) return num;
	return undefined;
}

function hasEventKeyword(line: string): boolean {
	const lower = line.toLowerCase();
	return KEYWORDS.some(k => lower.includes(k));
}

function extractEventsFromLine(line: string, fallbackYear: number): ExtractedEvent[] {
	const events: ExtractedEvent[] = [];
	const keywordBonus = hasEventKeyword(line);

	const DAY_FR = '(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)';
	const rangeFR = line.match(
		new RegExp(`\\b(?:du\\s+|depuis\\s+)?(?:${DAY_FR}\\s+)?(\\d{1,2})\\s*(?:er)?\\s+(?:de\\s+)?([A-Za-zàâäéèêëîïôöùûüç]+)(?:\\s+(\\d{4}))?\\s+au\\s+(?:${DAY_FR}\\s+)?(\\d{1,2})\\s*(?:er)?\\s+(?:de\\s+)?([A-Za-zàâäéèêëîïôöùûüç]+)(?:\\s+(\\d{4}))?\\b`, 'i')
	);
	if (rangeFR) {
		const m1 = monthFromName(rangeFR[2]);
		const m2 = monthFromName(rangeFR[5]);
		if (m1 && m2) {
			events.push({
				year: rangeFR[3] ? parseInt(rangeFR[3]) : (rangeFR[6] ? parseInt(rangeFR[6]) : fallbackYear),
				month: m1, day: parseInt(rangeFR[1]),
				endYear: rangeFR[6] ? parseInt(rangeFR[6]) : undefined,
				endMonth: m2, endDay: parseInt(rangeFR[4]),
				allDay: true,
				title: line.trim().slice(0, 120),
				sourceLine: line.trim(),
			});
			return events;
		}
	}

	const numericMatches = [...line.matchAll(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/g)];
	for (const m of numericMatches) {
		let day = parseInt(m[1]);
		let month = parseInt(m[2]);
		let year = parseInt(m[3]);
		if (m[3].length === 2) year += 2000;
		if (year > parseInt(m[1]) && parseInt(m[1]) <= 31 && parseInt(m[2]) >= 1 && parseInt(m[1]) <= 12) {

			const d = day; const mo = month;
			year = parseInt(m[3].length === 4 ? m[3] : `20${m[3]}`);

		}
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
			events.push({
				year, month, day, allDay: true,
				title: line.trim().slice(0, 120),
				sourceLine: line.trim(),
			});
		}
	}

	const namedMatches = [...line.matchAll(
		/\b(?:(?:le|la|au|on|the)\s+)?(\d{1,2})(?:er|st|nd|rd|th)?\s+(?:de\s+)?([A-Za-zàâäéèêëîïôöùûüç]+)(?:\s+(\d{4}))?\b|\b([A-Za-zàâäéèêëîïôöùûüç]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi
	)];
	for (const m of namedMatches) {
		let day: number, monthWord: string, year: number;
		if (m[1]) {
			day = parseInt(m[1]); monthWord = m[2]; year = m[3] ? parseInt(m[3]) : fallbackYear;
		} else {
			monthWord = m[4]; day = parseInt(m[5]); year = m[6] ? parseInt(m[6]) : fallbackYear;
		}
		const month = monthFromName(monthWord);
		if (month && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {

			const dup = events.some(e => e.year === year && e.month === month && e.day === day);
			if (!dup) {
				events.push({ year, month, day, allDay: true, title: line.trim().slice(0, 120), sourceLine: line.trim() });
			}
		}
	}

	return events;
}

async function readFileText(fullPath: string): Promise<string> {
	const ext = path.extname(fullPath).toLowerCase();
	if (ext === '.docx') {

		const { execSync } = await import('child_process');
		try {

			const xml = execSync(`unzip -p "${fullPath.replace(/"/g, '\\"')}" word/document.xml`, { maxBuffer: 50 * 1024 * 1024 }).toString('utf-8');
			return xml
				.replace(/<\/w:p>/g, '\n')
				.replace(/<[^>]+>/g, '')
				.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
		} catch (err) {
			throw new Error(`DOCX extraction failed (unzip unavailable?): ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (ext === '.pdf') {
		const { execSync } = await import('child_process');
		try {
			return execSync(`pdftotext "${fullPath.replace(/"/g, '\\"')}" -`, { maxBuffer: 50 * 1024 * 1024, encoding: 'utf-8' });
		} catch {
			throw new Error('PDF extraction needs pdftotext (poppler-utils) installed');
		}
	}

	return fs.readFileSync(fullPath, 'utf-8');
}

function pad(n: number): string {
	return n < 10 ? `0${n}` : `${n}`;
}

function icsDate(year: number, month: number, day: number): string {
	return `${year}${pad(month)}${pad(day)}`;
}

function addDays(year: number, month: number, day: number, days: number): { y: number; m: number; d: number } {
	const d = new Date(Date.UTC(year, month - 1, day + days));
	return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function foldIcsLine(line: string): string {

	const out: string[] = [];
	let rest = line;
	while (rest.length > 74) {
		out.push(rest.slice(0, 74));
		rest = ' ' + rest.slice(74);
	}
	out.push(rest);
	return out.join('\r\n');
}

function buildIcs(events: ExtractedEvent[], calendarName: string, sourceFile: string): string {
	const now = new Date();
	const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
	const lines: string[] = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//vscode-mcp-server//generate_ics_code//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		foldIcsLine(`X-WR-CALNAME:${calendarName}`),
	];
	let uidCounter = 0;
	for (const ev of events) {
		uidCounter += 1;
		lines.push('BEGIN:VEVENT');
		lines.push(foldIcsLine(`UID:${stamp}-${uidCounter}@vscode-mcp-server`));
		lines.push(`DTSTAMP:${stamp}`);
		const start = icsDate(ev.year, ev.month, ev.day);
		if (ev.endDay) {

			const endPlus = addDays(ev.endYear ?? ev.year, ev.endMonth ?? ev.endMonth ?? ev.month, ev.endDay, 1);
			lines.push(`DTSTART;VALUE=DATE:${start}`);
			lines.push(`DTEND;VALUE=DATE:${icsDate(endPlus.y, endPlus.m, endPlus.d)}`);
		} else {
			lines.push(`DTSTART;VALUE=DATE:${start}`);
			lines.push(`DTEND;VALUE=DATE:${start}`);
		}
		const cleanTitle = ev.title.replace(/\r?\n/g, ' ').replace(/,/g, '\\,').replace(/;/g, '\\;');
		lines.push(foldIcsLine(`SUMMARY:${cleanTitle}`));
		const srcEscaped = sourceFile.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;');
		lines.push(foldIcsLine(`DESCRIPTION:Extracted from ${srcEscaped} — line: ${ev.sourceLine.replace(/\r?\n/g, ' ')}`));
		lines.push('TRANSP:TRANSPARENT');
		lines.push('END:VEVENT');
	}
	lines.push('END:VCALENDAR');
	return lines.join('\r\n') + '\r\n';
}

export function registerCalendarTools(server: McpServer): void {
	server.tool(
		'generate_ics_code', `Generate .ics calendar file from document dates.`,
		{
			path: z.string().describe('The document to read (.md, .txt, .docx, .pdf)'),
			output: z.string().optional().describe('Output .ics path (default: alongside the source file, same base name). Relative to workspace.'),
			calendarName: z.string().default('Dates extraites').describe('Name shown for this calendar after import'),
			keywords: z.array(z.string()).optional().describe('Extra keywords that mark a line as an event (in addition to built-in congés/vacances/examen/…)'),
			requireKeyword: z.boolean().default(true).describe('Only keep lines containing an event keyword (recommended: fewer false positives)'),
			year: z.number().int().min(2000).max(2100).optional().describe('Fallback year when a date has none (default: current year)'),
			workspace: z.string().optional().describe(WORKSPACE_PARAM_DESCRIPTION),
		},
		async ({ path: filePath, output, calendarName, keywords, requireKeyword, year, workspace }): Promise<CallToolResult> => {
			try {
				const uri = resolveInputPath(filePath, workspace);
				const fullPath = uri.fsPath;
				if (!fs.existsSync(fullPath)) {
					return { content: [{ type: 'text', text: `Error: file not found: ${filePath}` }], isError: true };
				}

				const effectiveKeywords = [...KEYWORDS, ...(keywords ?? [])];
				const effectiveRequire = keywords !== undefined ? true : requireKeyword;

				const text = await readFileText(fullPath);
				const lines = text.split(/\r?\n/);
				const fallbackYear = year ?? new Date().getUTCFullYear();
				const allEvents: ExtractedEvent[] = [];

				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (!line || line.trim().length < 4) continue;
					const found = extractEventsFromLine(line, fallbackYear);
					if (found.length === 0) continue;
					const lower = line.toLowerCase();
					const matches = effectiveKeywords.some(k => lower.includes(k.toLowerCase()));
					if (effectiveRequire && !matches) continue;
					for (const ev of found) {
						ev.sourceLine = `L${i + 1}: ${ev.sourceLine}`;
						allEvents.push(ev);
					}
				}

				if (allEvents.length === 0) {
					return { content: [{ type: 'text', text: `No dated events found in ${filePath}${effectiveRequire ? ' (keyword filter active — try requireKeyword=false)' : ''}. Supported: French/English month names, dd/mm/yyyy, yyyy-mm-dd.` }] };
				}

				allEvents.sort((a, b) => (a.year * 10000 + a.month * 100 + a.day) - (b.year * 10000 + b.month * 100 + b.day));

				const sourceBase = path.basename(filePath, path.extname(filePath));
				const outRelative = output ?? `${sourceBase}.ics`;
				const outUri = resolveInputPath(outRelative, workspace);
				fs.mkdirSync(path.dirname(outUri.fsPath), { recursive: true });

				const icsContent = buildIcs(allEvents, calendarName, filePath);
				fs.writeFileSync(outUri.fsPath, icsContent, 'utf-8');

				const listing = allEvents.map((ev, idx) => {
					const range = ev.endDay ? ` -> ${pad(ev.endDay)}/${pad(ev.endMonth ?? ev.month)}/${ev.endYear ?? ev.year}` : '';
					return `${idx + 1}. ${pad(ev.day)}/${pad(ev.month)}/${ev.year}${range} — ${ev.title}`;
				}).join('\n');

				logger.info(`[generate_ics_code] ${allEvents.length} event(s) from ${filePath} -> ${outUri.fsPath}`);
				const relOut = path.basename(outUri.fsPath);
				return {
					content: [{ type: 'text', text: `Calendar written: ${relOut}\n${allEvents.length} event(s) extracted:\n\n${listing}\n\nImport this .ics into Google Calendar / Outlook / Apple Calendar / Obsidian.` }]
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				logger.error(`[generate_ics_code] ${msg}`);
				return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
			}
		}
	);
}
