const { createRequire } = require('node:module');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { buildSync } = createRequire(require.resolve('tsup'))('esbuild');
const root = path.resolve(__dirname, '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'pt-hangul-test-'));
const bundle = path.join(scratch, 'hangul-input.js');
const assert = require('node:assert/strict');
const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15';
(async () => {
  buildSync({
    entryPoints: [path.join(root, 'src/lib/terminal-hangul-input.ts')],
    bundle: true, format: 'iife', globalName: 'hangulBridge', outfile: bundle,
  });
  for (const engine of ['chromium','webkit']) {
    const browser = await (engine === 'chromium' ? chromium.launch({headless:true,args:['--no-sandbox']}) : webkit.launch({headless:true}));
    try {
      const page = await browser.newPage({userAgent:safari,viewport:{width:900,height:500}});
      await page.setContent('<div id="terminal" style="width:800px;height:400px"></div>');
      await page.addStyleTag({path:path.join(root, 'node_modules/@xterm/xterm/css/xterm.css')});
      await page.addScriptTag({path:path.join(root, 'node_modules/@xterm/xterm/lib/xterm.js')});
      await page.addScriptTag({path:bundle});
      const results = await page.evaluate(async () => {
        const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
        const results=[];
        const run=async(name,expected,test)=>{
          document.querySelector('#terminal').replaceChildren();
          const terminal=new Terminal({cols:70,rows:16,fontSize:18});
          terminal.open(document.querySelector('#terminal'));
          const bridge=hangulBridge.attachTerminalHangulInput(terminal);
          let sent=''; terminal.onData(data=>sent+=data); terminal.focus(); await tick();
          const ta=terminal.textarea;
          const key=(key,keyCode,props={})=>{
            const event=new KeyboardEvent('keydown',{key,code:key,keyCode,bubbles:true,cancelable:true,...props});
            ta.dispatchEvent(event); return event;
          };
          const edit=async(value,data,inputType='insertReplacementText')=>{
            ta.value=value; ta.setSelectionRange(value.length,value.length);
            ta.dispatchEvent(new InputEvent('input',{data,inputType,isComposing:false,bubbles:true,composed:true}));
            key(data??'Backspace',229);
            await tick();
            ta.dispatchEvent(new KeyboardEvent('keyup',{key:data??'Backspace',keyCode:229,bubbles:true}));
          };
          const write=text=>new Promise(resolve=>terminal.write(text,resolve));
          const preview=()=>[...terminal.element.querySelectorAll('.composition-view.active')].map(e=>e.textContent).join('');
          await test({terminal,bridge,ta,key,edit,write,preview,clear:()=>sent='',sent:()=>sent});
          await tick();
          results.push({name,expected,actual:sent});
          bridge.dispose(); terminal.dispose();
        };
        await run('syllables + Enter','한글\r',async({edit,key,preview})=>{
          await edit('ㅎ','ㅎ','insertText'); await edit('하','하'); await edit('한','한');
          if(preview()!=='한') throw new Error('Missing pending preview');
          await edit('한ㄱ','ㄱ','insertText'); await edit('한그','그'); await edit('한글','글'); key('Enter',13);
        });
        await run('consonant moves to next syllable','하세\r',async({edit,key})=>{
          await edit('ㅎ','ㅎ','insertText'); await edit('하','하'); await edit('핫','핫'); await edit('하','하'); await edit('하세','세','insertText'); key('Enter',13);
        });
        await run('Shift preserves composition','했\r',async({edit,key})=>{
          await edit('해','해','insertText'); key('Shift',16,{shiftKey:true}); await edit('했','했'); key('Enter',13);
        });
        await run('Backspace edits then erases pending syllable','\r',async({edit,key})=>{
          await edit('한','한','insertText'); key('Backspace',8); await edit('하',null,'deleteContentBackward'); await edit('ㅎ',null,'deleteContentBackward'); await edit('',null,'deleteContentBackward'); key('Enter',13);
        });
        await run('space + punctuation delivered after Hangul','한 글.\r',async({edit,key})=>{
          await edit('한','한','insertText'); await edit('한 ',' ','insertText'); await edit('한 글','글','insertText'); await edit('한 글.','.','insertText'); key('Enter',13);
        });
        await run('Ctrl+C after pending syllable','한\u0003',async({edit,key})=>{
          await edit('한','한','insertText'); key('c',67,{ctrlKey:true});
        });
        await run('ArrowLeft after pending syllable','한\u001b[D',async({edit,key})=>{
          await edit('한','한','insertText'); key('ArrowLeft',37);
        });
        await run('flush before blur focus report','한\u001b[O',async({edit,write,ta,clear})=>{
          await write('\u001b[?1004h'); clear(); await edit('한','한','insertText'); ta.blur();
        });
        await run('flush before bracketed paste','한\u001b[200~붙여넣기\u001b[201~',async({edit,write,ta})=>{
          await write('\u001b[?2004h'); await edit('한','한','insertText');
          const event=new Event('paste',{bubbles:true,cancelable:true});
          Object.defineProperty(event,'clipboardData',{value:{getData:()=> '붙여넣기'}}); ta.dispatchEvent(event);
        });
        await run('native composition preserved','한\r',async({ta,key})=>{
          key('Process',229);
          ta.dispatchEvent(new CompositionEvent('compositionstart',{data:'',bubbles:true}));
          for(const data of ['ㅎ','하','한']){
            ta.dispatchEvent(new CompositionEvent('compositionupdate',{data,bubbles:true}));
            ta.value=data;ta.setSelectionRange(data.length,data.length);
            ta.dispatchEvent(new InputEvent('input',{data,inputType:'insertCompositionText',isComposing:true,bubbles:true,composed:true}));await tick();
          }
          ta.dispatchEvent(new CompositionEvent('compositionend',{data:'한',bubbles:true}));await tick();key('Enter',13);
        });
        await run('reset discards pending syllable','\r',async({edit,bridge,terminal,key})=>{
          await edit('한','한','insertText');bridge.reset();terminal.reset();key('Enter',13);
        });
        await run('ASCII keyboard path','abc\r',async({ta,key})=>{
          for(const c of 'abc'){
            const e=key(c,c.toUpperCase().charCodeAt(0));
            if(!e.defaultPrevented) ta.dispatchEvent(new KeyboardEvent('keypress',{key:c,charCode:c.charCodeAt(0),keyCode:c.charCodeAt(0),bubbles:true,cancelable:true}));
            ta.dispatchEvent(new KeyboardEvent('keyup',{key:c,keyCode:c.toUpperCase().charCodeAt(0),bubbles:true}));
          } key('Enter',13);
        });
        await run('scrollback input reveals pending preview','',async({terminal,edit,write,preview})=>{
          await write(Array.from({length:40},(_,i)=>'line '+i+'\r\n').join(''));
          terminal.scrollToTop(); await tick();
          await edit('한','한','insertText');
          if(terminal.buffer.active.viewportY!==terminal.buffer.active.baseY) throw new Error('Input did not scroll to bottom');
          if(preview()!=='한') throw new Error('Pending syllable is invisible');
        });
        for (const boundary of ['deletion','space']) {
          await run('fast rollover after '+boundary,boundary==='space'?'ㅎ 가\r':'가\r',async({ta,key,edit})=>{
            await edit('ㅎ','ㅎ','insertText');
            const fast=(value,data,inputType)=>{
              ta.value=value; ta.setSelectionRange(value.length,value.length);
              ta.dispatchEvent(new InputEvent('input',{data,inputType,isComposing:false,bubbles:true,composed:true}));
              key(data??'Backspace',229);
            };
            const prefix=boundary==='space'?'ㅎ ':'';
            fast(prefix,boundary==='space'?' ':null,boundary==='space'?'insertText':'deleteContentBackward');
            fast(prefix+'ㄱ','ㄱ','insertText');
            await tick();
            await edit(prefix+'가','가');key('Enter',13);
          });
        }
        return results;
      });
      console.log(`${engine}: ${results.length} input traces`);
      for(const result of results) assert.equal(result.actual,result.expected,engine+': '+result.name);
    } finally { await browser.close(); }
  }
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>rmSync(scratch,{recursive:true,force:true}));
