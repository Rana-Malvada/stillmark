"""Build the architect review document from its versioned Markdown source."""
from pathlib import Path
import re, json
from PIL import Image, ImageDraw, ImageFont
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'docs/architecture'
ASSETS=BASE/'stillmark-target-state-assets'
FONT='/System/Library/Fonts/Supplemental/Arial.ttf'
BOLD='/System/Library/Fonts/Supplemental/Arial Bold.ttf'
INK='#263340'; MUTED='#536471'; AMBER='#B67D24'; LINE='#78909C'
def diagram(name, boxes, edges, size=(1800,900)):
 im=Image.new('RGB',size,'white');d=ImageDraw.Draw(im)
 for pts,label in edges:
  d.line(pts,fill=LINE,width=4)
  x,y=pts[-1];px,py=pts[-2];dx=x-px;dy=y-py
  import math
  a=math.atan2(dy,dx); l=16
  d.polygon([(x,y),(x-l*math.cos(a-.5),y-l*math.sin(a-.5)),(x-l*math.cos(a+.5),y-l*math.sin(a+.5))],fill=LINE)
  if label:
   mx,my=pts[len(pts)//2]; f=ImageFont.truetype(FONT,26); bb=d.textbbox((0,0),label,font=f)
   d.rectangle((mx-bb[2]/2-8,my-35,mx+bb[2]/2+8,my-3),fill='white');d.text((mx-bb[2]/2,my-35),label,font=f,fill=MUTED)
 for xy,title,body,kind in boxes:
  d.rounded_rectangle(xy,radius=14,fill='#F8F4ED' if kind=='target' else '#F0F4F6',outline=AMBER if kind=='target' else '#56717F',width=3)
  x1,y1,x2,y2=xy;tf=ImageFont.truetype(BOLD,32);bf=ImageFont.truetype(FONT,27)
  lines=title.split('\n');bl=body.split('\n') if body else [];total=len(lines)*39+len(bl)*34+10
  y=y1+(y2-y1-total)/2
  for s in lines:
   w=d.textlength(s,font=tf);d.text(((x1+x2-w)/2,y),s,font=tf,fill=INK);y+=39
  y+=10
  for s in bl:
   w=d.textlength(s,font=bf);d.text(((x1+x2-w)/2,y),s,font=bf,fill=MUTED);y+=34
 im.save(ASSETS/f'{name}.png')
diagram('context',[
 ((30,45,400,200),'Web and mobile','Sessions and\nresumable transfers',''),
 ((510,45,1050,200),'Cloudflare edge','Session checks and trusted routing',''),
 ((1210,45,1760,200),'Auth0','Login and session lifecycle',''),
 ((510,310,1050,475),'Owner placement directory','Cell and routing generation','target'),
 ((30,620,540,850),'Cell A','App • uploads • primary and replicas\nInternal stages • search • batches','target'),
 ((645,620,1155,850),'Cell B','Independent capacity\nSame code and safety contracts','target'),
 ((1260,620,1770,850),'Cell N','Independent capacity\nand recovery boundaries','target')],
 [([(400,120),(510,120)],''), ([(1050,120),(1210,120)],''), ([(780,200),(780,310)],''), ([(780,475),(780,540),(285,540),(285,620)],''), ([(780,540),(900,540),(900,620)],''), ([(900,540),(1515,540),(1515,620)],'')])
diagram('cell',[
 ((35,35,550,195),'Application services','Stateless UI and bounded API work',''),
 ((640,35,1155,195),'Upload CPU service','Receiver and durable consumers',''),
 ((1245,35,1760,195),'Batch CPU and GPU pools','Faces • OCR • video • ranking',''),
 ((35,340,550,510),'Read replicas','Approved reads and freshness gate','target'),
 ((640,340,1155,510),'Postgres primary','Catalog • ACLs • jobs • outbox',''),
 ((1245,340,1760,510),'Internal stages','Originals • derivatives • models',''),
 ((35,680,550,850),'HA standby','Recovery role not read scaling','target'),
 ((640,680,1155,850),'Search publication','Finite revisioned indexing work','target'),
 ((1245,680,1760,850),'Cortex Search partitions','Trusted scope and result validation','target')],
 [([(292,195),(292,340)],''), ([(550,115),(595,115),(595,380),(640,380)],''), ([(898,195),(898,340)],''), ([(1502,195),(1502,340)],''), ([(1155,115),(1195,115),(1195,380),(1245,380)],''), ([(1502,195),(1502,270),(1000,270),(1000,340)],''), ([(640,425),(550,425)],''), ([(640,470),(595,470),(595,765),(550,765)],''), ([(898,510),(898,680)],''), ([(1155,765),(1245,765)],'')])
diagram('replica',[
 ((40,60,530,235),'Named read operation','Verified owner and consistency class',''),
 ((670,60,1160,235),'Primary security gate','Current access and sensitive revision',''),
 ((1300,60,1770,235),'Freshness admission','Replay position and causal fence','target'),
 ((40,570,530,760),'Primary read','Writes and fresh reads\nBounded fallback capacity',''),
 ((670,570,1160,760),'Eligible replica read','Read only and tenant scoped','target'),
 ((1300,570,1770,760),'Return or fail closed','Final authoritative validation\nNo stale permission fallback','target')],
 [([(530,145),(670,145)],''), ([(1160,145),(1300,145)],''), ([(1535,235),(1535,400),(915,400),(915,570)],'fresh'), ([(1300,195),(1240,195),(1240,460),(285,460),(285,570)],'primary required'), ([(285,760),(285,800),(1535,800),(1535,760)],''), ([(1160,665),(1300,665)],'')],size=(1800,820))
diagram('upload',[
 ((30,50,540,220),'Receiving','Durable chunks and stable upload ID',''),
 ((645,50,1155,220),'Queued','Inputs sealed • HTTP 202',''),
 ((1260,50,1770,220),'Processing','Claim token • lease • heartbeat',''),
 ((30,570,540,760),'Failed or canceled','Visible reason and safe retry policy',''),
 ((645,570,1155,760),'Published','Atomic result and usage record',''),
 ((1260,570,1770,760),'Fenced commit','Lease and permissions rechecked','')],
 [([(540,135),(645,135)],''), ([(1155,135),(1260,135)],''), ([(1515,220),(1515,570)],''), ([(1260,665),(1155,665)],''), ([(1515,220),(1515,400),(900,400),(900,220)],'retry or expired lease'), ([(900,400),(285,400),(285,570)],'budget exhausted / denied')],size=(1800,820))

def plain(s):return s.replace('`','').replace('**','')
def runs(p,s):
 for bit in re.split(r'(\*\*.*?\*\*|`[^`]+`)',s):
  if not bit:continue
  r=p.add_run(bit[2:-2] if bit.startswith('**') else bit[1:-1] if bit.startswith('`') else bit)
  if bit.startswith('**'):r.bold=True
  if bit.startswith('`'):r.font.name='Calibri';r.font.size=Pt(10.5)

doc=Document();sec=doc.sections[0];sec.page_width=Inches(8.5);sec.page_height=Inches(11)
sec.top_margin=Inches(.68);sec.bottom_margin=Inches(.65);sec.left_margin=Inches(.7);sec.right_margin=Inches(.7)
sec.header_distance=Inches(.28);sec.footer_distance=Inches(.28)
styles=doc.styles
for n in ['Normal','Body Text']:
 styles[n].font.name='Calibri';styles[n].font.size=Pt(11);styles[n].font.color.rgb=RGBColor.from_string('263340')
 styles[n].paragraph_format.space_after=Pt(7);styles[n].paragraph_format.line_spacing=1.05
for n,size in [('Title',30),('Heading 1',20),('Heading 2',12)]:
 styles[n].font.name='Calibri';styles[n].font.size=Pt(size);styles[n].font.bold=True;styles[n].font.color.rgb=RGBColor.from_string('000000')
 styles[n].paragraph_format.space_before=Pt(10 if n=='Heading 2' else 0);styles[n].paragraph_format.space_after=Pt(9)
styles['Heading 1'].paragraph_format.page_break_before=True
styles['Caption'].font.size=Pt(9);styles['Caption'].font.color.rgb=RGBColor.from_string('536471')
styles['Caption'].paragraph_format.space_after=Pt(8)
sec.header.paragraphs[0].text='STILLMARK  /  ARCHITECTURE DESIGN'
sec.header.paragraphs[0].runs[0].font.size=Pt(8);sec.header.paragraphs[0].runs[0].font.color.rgb=RGBColor.from_string('000000')
f=sec.footer.paragraphs[0];f.paragraph_format.space_before=Pt(0);r=f.add_run('Architecture review  •  27 October 2026');r.font.size=Pt(8)
f.add_run('\t');f.paragraph_format.tab_stops.add_tab_stop(Inches(6.9),2)
r=f.add_run();field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'PAGE');r._r.addnext(field)
doc.core_properties.title='Stillmark Architecture Design';doc.core_properties.subject='Architecture review and reliability design';doc.core_properties.author='Stillmark';doc.core_properties.keywords='architecture, scalability, PostgreSQL, replicas, reliability'
text=(BASE/'stillmark-target-state.md').read_text();lines=text.splitlines();chapters=[l[2:] for l in lines if l.startswith('# ')][1:]
page_map={}
mapfile=ASSETS/'page-map.json'
if mapfile.exists():page_map=json.loads(mapfile.read_text())
inserted=False;i=0
while i<len(lines):
 line=lines[i].strip();i+=1
 if not line:continue
 if line.startswith('# '):
  title=line[2:]
  if not inserted and title.startswith('01 '):
   doc.add_paragraph('Contents','Heading 1')
   for c in chapters:
    p=doc.add_paragraph();p.paragraph_format.space_after=Pt(3);p.paragraph_format.line_spacing=1.0
    p.paragraph_format.tab_stops.add_tab_stop(Inches(6.9),2)
    p.add_run(c).font.size=Pt(10.5);p.add_run('\t'+str(page_map.get(c,''))).font.size=Pt(10.5)
   inserted=True
  doc.add_paragraph(title,'Heading 1' if title!= 'Stillmark Architecture Design' else 'Title');continue
 if line.startswith('## '):doc.add_paragraph(line[3:],'Heading 2');continue
 if line.startswith('!['):
  m=re.match(r'!\[(.*?)\]\((.*?)\)',line);p=doc.add_paragraph();p.paragraph_format.space_after=Pt(3)
  pic=p.add_run().add_picture(str(BASE/m.group(2)),width=Inches(7.05));pic._inline.docPr.set('descr',m.group(1));continue
 if line.startswith('|'):
  rows=[line]
  while i<len(lines) and lines[i].strip().startswith('|'):rows.append(lines[i].strip());i+=1
  parsed=[[x.strip() for x in r.strip('|').split('|')] for r in rows if not re.fullmatch(r'[| :\-]+',r)]
  t=doc.add_table(rows=0,cols=len(parsed[0]));t.autofit=False
  borders=OxmlElement('w:tblBorders')
  for edge in ['top','left','bottom','right','insideH','insideV']:
   border=OxmlElement('w:'+edge);border.set(qn('w:val'),'single');border.set(qn('w:sz'),'4');border.set(qn('w:color'),'D9D9D9');borders.append(border)
  t._tbl.tblPr.append(borders)
  widths=([1.65,2.65,2.8] if len(parsed[0])==3 else [2.05,5.05])
  for col,w in zip(t.columns,widths):col.width=Inches(w)
  for ri,row in enumerate(parsed):
   cells=t.add_row().cells
   for ci,val in enumerate(row):
    cells[ci].vertical_alignment=1;cells[ci].width=Inches(widths[ci]);tcpr=cells[ci]._tc.get_or_add_tcPr();mar=OxmlElement('w:tcMar')
    for edge in ['top','left','bottom','right']:
     el=OxmlElement('w:'+edge);el.set(qn('w:w'),'85');el.set(qn('w:type'),'dxa');mar.append(el)
    tcpr.append(mar)
    if ri==0:
     shade=OxmlElement('w:shd');shade.set(qn('w:fill'),'E9EDF0');tcpr.append(shade)
    elif ri%2==0:
     shade=OxmlElement('w:shd');shade.set(qn('w:fill'),'F7F8F9');tcpr.append(shade)
    p=cells[ci].paragraphs[0];p.paragraph_format.space_after=Pt(1);p.paragraph_format.line_spacing=1.0;runs(p,val)
    for r in p.runs:r.font.size=Pt(10);r.bold=ri==0
   trpr=t.rows[-1]._tr.get_or_add_trPr();cant=OxmlElement('w:cantSplit');trpr.append(cant)
   if ri==0:trpr.append(OxmlElement('w:tblHeader'))
  doc.add_paragraph().paragraph_format.space_after=Pt(0);continue
 p=doc.add_paragraph(style='Caption' if line.startswith('Figure ') else None);runs(p,line)
 # Body paragraphs are kept naturally flowing; never keep an entire section as one block.
 p.paragraph_format.widow_control=True
for root in [doc.styles.element, doc.element]:
 for border in root.xpath('.//w:pBdr'):border.getparent().remove(border)
destination=ROOT/'output/docs'
destination.mkdir(parents=True,exist_ok=True)
out=destination/'Stillmark Architecture Design.docx';doc.save(out)
print(out)
print('Words',len(re.findall(r'\S+',text)))
