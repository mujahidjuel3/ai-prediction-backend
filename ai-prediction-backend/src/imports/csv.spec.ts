import { parseCsv, safeCsvCell, serializeCsv } from './csv';

describe('CSV safety utilities',()=>{
 it('parses quoted commas and escaped quotes',()=>{expect(parseCsv('a,b\n"one, two","say ""hi"""')).toEqual([['a','b'],['one, two','say "hi"']]);});
 it('rejects malformed quote placement',()=>{expect(()=>parseCsv('a,b\none,tw"o')).toThrow();expect(()=>parseCsv('a,b\n"not closed,x')).toThrow();});
 it('neutralizes formula cells in report exports',()=>{expect(safeCsvCell('=1+1')).toBe("'=1+1");expect(serializeCsv([['name','score'],['safe',12]])).toContain('safe,12');});
});
