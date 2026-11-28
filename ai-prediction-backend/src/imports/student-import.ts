import { AccountStatus } from '@prisma/client';
import { parseCsv } from './csv';

/** Matches Admin Reports student-directory export headers (reports-view.tsx). */
export const STUDENT_CSV_REQUIRED = [
  'student_number',
  'name',
  'email',
  'department_code',
  'enrollment_year',
  'status',
] as const;

export const STUDENT_IMPORT_KIND = 'students' as const;

export type StudentImportRow = {
  importKind: typeof STUDENT_IMPORT_KIND;
  line: number;
  studentNumber: string;
  name: string;
  email: string | null;
  departmentId: string;
  enrollmentYear: number;
  status: AccountStatus;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const STUDENT_IMPORT_MAX_ROWS = 500;

export function isStudentImportPayload(payload: unknown): payload is StudentImportRow[] {
  if (!Array.isArray(payload) || payload.length === 0) return false;
  const first = payload[0];
  return Boolean(first && typeof first === 'object' && (first as { importKind?: unknown }).importKind === STUDENT_IMPORT_KIND);
}

export function parseStudentCsvTable(csv: string): { headers: string[]; raw: string[][] } {
  const table = parseCsv(csv);
  if (!table.length) throw new Error('CSV is empty');
  const headers = table[0].map((h) => h.trim().toLowerCase());
  const missing = STUDENT_CSV_REQUIRED.filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`Missing required CSV columns: ${missing.join(', ')}`);
  const raw = table.slice(1);
  if (!raw.length) throw new Error('CSV has no data rows');
  if (raw.length > STUDENT_IMPORT_MAX_ROWS) {
    throw new Error(`CSV supports at most ${STUDENT_IMPORT_MAX_ROWS} data rows per preview`);
  }
  return { headers, raw };
}

export function col(row: string[], headers: string[], name: string) {
  return row[headers.indexOf(name)]?.trim() ?? '';
}

export function validateStudentImportRows(input: {
  headers: string[];
  raw: string[][];
  departmentsByCode: Map<string, { id: string; code: string }>;
  existingStudentNumbers: Set<string>;
  existingEmails: Set<string>;
}): Array<{ line: number; errors: string[]; normalized: StudentImportRow | null }> {
  const seenNumbers = new Set<string>();
  const seenEmails = new Set<string>();

  return input.raw.map((row, index) => {
    const line = index + 2;
    const errors: string[] = [];
    const studentNumber = col(row, input.headers, 'student_number');
    const name = col(row, input.headers, 'name');
    const emailRaw = col(row, input.headers, 'email');
    const departmentCode = col(row, input.headers, 'department_code');
    const yearRaw = col(row, input.headers, 'enrollment_year');
    const statusRaw = col(row, input.headers, 'status');

    if (!studentNumber || studentNumber.length < 2 || studentNumber.length > 64) {
      errors.push('student_number must be 2–64 characters');
    } else {
      const key = studentNumber.toLowerCase();
      if (seenNumbers.has(key)) errors.push('Duplicate student_number in this CSV');
      else seenNumbers.add(key);
      if (input.existingStudentNumbers.has(key)) errors.push('student_number already exists');
    }

    if (!name || name.length < 2 || name.length > 160) {
      errors.push('name must be 2–160 characters');
    }

    let email: string | null = null;
    if (emailRaw) {
      email = emailRaw.toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254) {
        errors.push('email must be a valid email address');
        email = null;
      } else if (seenEmails.has(email)) {
        errors.push('Duplicate email in this CSV');
      } else if (input.existingEmails.has(email)) {
        errors.push('email already exists on a user or student profile');
      } else {
        seenEmails.add(email);
      }
    }

    const department = input.departmentsByCode.get(departmentCode.toUpperCase());
    if (!departmentCode) errors.push('department_code is required');
    else if (!department) errors.push('Unknown department_code');

    const enrollmentYear = Number(yearRaw);
    if (!Number.isInteger(enrollmentYear) || enrollmentYear < 1900 || enrollmentYear > 2200) {
      errors.push('enrollment_year must be an integer from 1900 to 2200');
    }

    const statusNormalized = (statusRaw || 'ACTIVE').toUpperCase();
    if (statusNormalized !== 'ACTIVE' && statusNormalized !== 'INACTIVE') {
      errors.push('status must be ACTIVE or INACTIVE');
    }

    if (errors.length || !department) {
      return { line, errors, normalized: null };
    }

    return {
      line,
      errors: [],
      normalized: {
        importKind: STUDENT_IMPORT_KIND,
        line,
        studentNumber,
        name,
        email,
        departmentId: department.id,
        enrollmentYear,
        status: statusNormalized as AccountStatus,
      },
    };
  });
}
