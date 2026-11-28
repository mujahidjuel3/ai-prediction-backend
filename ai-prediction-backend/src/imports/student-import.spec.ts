import { parseStudentCsvTable, validateStudentImportRows } from './student-import';

describe('student CSV import validation', () => {
  const headers = ['student_number', 'name', 'email', 'department_code', 'enrollment_year', 'status'];
  const departmentsByCode = new Map([['CSE', { id: 'dept-cse', code: 'CSE' }]]);

  it('accepts the Reports student-directory header set', () => {
    const csv = `${headers.join(',')}\nIST-CSE-001,Ayesha Rahman,ayesha@ist.edu.bd,CSE,2024,ACTIVE\n`;
    const parsed = parseStudentCsvTable(csv);
    expect(parsed.raw).toHaveLength(1);
    const rows = validateStudentImportRows({
      headers: parsed.headers,
      raw: parsed.raw,
      departmentsByCode,
      existingStudentNumbers: new Set(),
      existingEmails: new Set(),
    });
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].normalized).toEqual(expect.objectContaining({
      importKind: 'students',
      studentNumber: 'IST-CSE-001',
      departmentId: 'dept-cse',
      enrollmentYear: 2024,
      status: 'ACTIVE',
    }));
  });

  it('returns row-level errors for unknown department and duplicate numbers', () => {
    const raw = [
      ['IST-1', 'One', 'one@ist.edu.bd', 'EEE', '2024', 'ACTIVE'],
      ['IST-1', 'Two', 'two@ist.edu.bd', 'CSE', '2024', 'ACTIVE'],
    ];
    const rows = validateStudentImportRows({
      headers,
      raw,
      departmentsByCode,
      existingStudentNumbers: new Set(),
      existingEmails: new Set(),
    });
    expect(rows[0].errors).toContain('Unknown department_code');
    expect(rows[1].errors).toContain('Duplicate student_number in this CSV');
  });

  it('rejects missing required columns instead of inventing headers', () => {
    expect(() => parseStudentCsvTable('student_number,name\nA,B\n')).toThrow(/Missing required CSV columns/);
  });
});
