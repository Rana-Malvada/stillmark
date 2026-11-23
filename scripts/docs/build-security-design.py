"""Build the architect review document from its versioned Markdown source."""
from pathlib import Path
import re, json
from PIL import Image, ImageDraw, ImageFont
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
ROOT=Path(__file__).resolve().parents[2]
BASE=ROOT/'docs/security'
ASSETS=BASE/'stillmark-security-assets'
ASSETS.mkdir(parents=True,exist_ok=True)
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

diagram('boundaries',[
 ((30,35,500,195),'Browser and mobile','Untrusted input and session cookie',''),
 ((665,35,1135,195),'Cloudflare and Auth0','Login and signed assertions',''),
 ((1300,35,1770,195),'Application cell','Verified identity and scoped APIs',''),
 ((30,390,500,570),'Postgres primary','Permissions and durable state',''),
 ((665,390,1135,570),'Read replicas','Scoped reads and freshness',''),
 ((1300,390,1770,570),'Storage search and workers','Authorized data and delegated work','')],
 [([(500,115),(665,115)],''), ([(1135,115),(1300,115)],''),
 ([(1535,195),(1535,290),(265,290),(265,390)],'authoritative access'),
 ([(500,470),(665,470)],''), ([(1135,470),(1300,470)],'')],size=(1800,630))
diagram('identity',[
 ((30,35,540,200),'Gateway session','Verified subject and session ID',''),
 ((645,35,1155,200),'Signed request','Method target audience and expiry',''),
 ((1260,35,1770,200),'Application verification','Signature and request binding',''),
 ((30,385,540,560),'Resource authorization','Library and operation authority',''),
 ((645,385,1155,560),'Current identity','Linked user and session revocation',''),
 ((1260,385,1770,560),'Atomic replay claim','Unique assertion consumed once','')],
 [([(540,115),(645,115)],''), ([(1155,115),(1260,115)],''), ([(1515,200),(1515,385)],''),
 ([(1260,470),(1155,470)],''),( [(645,470),(540,470)],'')],size=(1800,620))
diagram('publication',[
 ((30,35,540,210),'Durable job','Owner inputs and authorization epoch',''),
 ((645,35,1155,210),'Exclusive claim','Lease token and attempt count',''),
 ((1260,35,1770,210),'Bounded processing','Heartbeat and workload isolation',''),
 ((30,420,540,595),'Published result','One catalog identity and accounting',''),
 ((645,420,1155,595),'Atomic publication','Current owner and lease validated',''),
 ((1260,420,1770,595),'Commit authority','Claims locked and epoch checked','')],
 [([(540,120),(645,120)],''), ([(1155,120),(1260,120)],''), ([(1515,210),(1515,420)],''),
 ([(1260,505),(1155,505)],''), ([(645,505),(540,505)],'')],size=(1800,655))

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
sec.header.paragraphs[0].text='STILLMARK  /  SECURITY ARCHITECTURE'
sec.header.paragraphs[0].runs[0].font.size=Pt(8);sec.header.paragraphs[0].runs[0].font.color.rgb=RGBColor.from_string('000000')
f=sec.footer.paragraphs[0];f.paragraph_format.space_before=Pt(0);r=f.add_run('Architecture review  •  27 October 2026');r.font.size=Pt(8)
f.add_run('\t');f.paragraph_format.tab_stops.add_tab_stop(Inches(6.9),2)
r=f.add_run();field=OxmlElement('w:fldSimple');field.set(qn('w:instr'),'PAGE');r._r.addnext(field)
doc.core_properties.title='Stillmark Security Architecture';doc.core_properties.subject='Architecture review and reliability design';doc.core_properties.author='Stillmark';doc.core_properties.keywords='architecture, scalability, PostgreSQL, replicas, reliability'
text=(BASE/'stillmark-security-design.md').read_text();lines=text.splitlines();chapters=[l[2:] for l in lines if l.startswith('# ')][1:]
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
  doc.add_paragraph(title,'Heading 1' if title!= 'Stillmark Security Architecture' else 'Title');continue
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
out=destination/'Stillmark Security Architecture.docx';doc.save(out)
print(out)
print('Words',len(re.findall(r'\S+',text)))
