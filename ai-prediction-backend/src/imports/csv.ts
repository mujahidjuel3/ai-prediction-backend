export function parseCsv(source:string):string[][]{
 const text=source.replace(/^\uFEFF/,'');const rows:string[][]=[];let row:string[]=[];let cell='';let quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else quoted=false;}else cell+=c;continue;}if(c==='"'){if(cell.length)throw new Error('Quote appeared inside an unquoted CSV field');quoted=true;}else if(c===','){row.push(cell.trim());cell='';}else if(c==='\n'){row.push(cell.trim());rows.push(row);row=[];cell='';}else if(c!=='\r')cell+=c;}
 if(quoted)throw new Error('CSV contains an unterminated quoted field');if(cell.length||row.length){row.push(cell.trim());rows.push(row);}return rows.filter(r=>r.some(v=>v.length>0));
}
export function safeCsvCell(value:unknown):string{let cell=String(value??'');if(/^[\s]*[=+@-]/.test(cell))cell=`'${cell}`;if(/[",\n\r]/.test(cell))cell=`"${cell.replaceAll('"','""')}"`;return cell;}
export function serializeCsv(rows:unknown[][]):string{return rows.map(row=>row.map(safeCsvCell).join(',')).join('\r\n');}
