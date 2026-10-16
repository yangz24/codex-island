import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const fmt = n => typeof n !== 'number' ? '—' : n >= 1e9 ? `${(n/1e9).toFixed(2)}B` : n >= 1e6 ? `${(n/1e6).toFixed(2)}M` : n >= 1e3 ? `${(n/1e3).toFixed(1)}K` : `${n}`;
const windowName = w => w.minutes >= 10080 ? '每周额度' : w.minutes >= 60 ? `${w.minutes/60} 小时额度` : `${w.minutes ?? '?'} 分钟额度`;
const countdown = t => {
    if (!t) return '重置时间未知';
    const s = Math.max(0, t - Date.now()/1000);
    if (s <= 0) return '等待额度更新';
    const m = Math.ceil(s/60), h = Math.floor(m/60), d = Math.floor(h/24);
    return d ? `${d}天 ${h%24}小时后重置` : h ? `${h}小时 ${m%60}分钟后重置` : `${m}分钟后重置`;
};
export default class CodexIsland extends Extension {
    enable() {
        this._alive = true;
        this._busy = false;this._proc=null;
        this._open = false;
        this._press = null;
        this._settings = this.getSettings('org.gnome.shell.extensions.codex-island');
        this._settingsId = this._settings.connect('changed', () => {
            if (!this._alive || this._savingPosition) return;
            this._render(); this._resize(); this._position();
        });
        this._sources = new Set();
        this._data = {};
        this._pinned = false;
        this._busy = false;
        this._root = new St.BoxLayout({vertical:true, style_class:'ci-root', reactive:true, track_hover:true, width:300, height:44, clip_to_allocation:true});
        this._head = new St.Button({style_class:'ci-head', reactive:true, can_focus:true, accessible_name:'Codex 用量，点击固定展开，右键刷新'});
        this._headBox = new St.BoxLayout({style_class:'ci-head-box'});
        this._dot = new St.Label({text:'●',style_class:'ci-dot'});
        this._title = new St.Label({text:'Codex',style_class:'ci-brand'});
        this._compact = new St.Label({text:'正在读取用量…',style_class:'ci-compact'});
        this._headBox.add_child(this._dot); this._headBox.add_child(this._title); this._headBox.add_child(this._compact);
        this._head.set_child(this._headBox); this._root.add_child(this._head);
        this._detail = new St.BoxLayout({vertical:true,style_class:'ci-detail',visible:false});
        this._root.add_child(this._detail);
        this._head.connect('button-press-event', (_a,e) => {
            if (e.get_button() === 3) {this._refresh();return Clutter.EVENT_STOP;}
            if (e.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            this._beginDrag(...e.get_coords());
            return Clutter.EVENT_STOP;
        });
        this._captureId=this._root.connect('captured-event',(_stage,e)=> {
            if (!this._press) return Clutter.EVENT_PROPAGATE;
            if(e.type()===Clutter.EventType.MOTION) {
                this._moveDrag(...e.get_coords());return Clutter.EVENT_STOP;
            }
            if(e.type()===Clutter.EventType.BUTTON_RELEASE && e.get_button()===1) {
                this._endDrag();return Clutter.EVENT_STOP;
            }
            if(e.type()===Clutter.EventType.KEY_PRESS && e.get_key_symbol()===Clutter.KEY_Escape) {
                this._endDrag(true);return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._head.connect('key-press-event', (_a,e) => {
            if (e.get_key_symbol() === Clutter.KEY_Escape) {this._pinned=false;this._expand(false);return Clutter.EVENT_STOP;}
            if (e.get_key_symbol() === Clutter.KEY_Return || e.get_key_symbol() === Clutter.KEY_space) {this._pinned=!this._pinned;this._expand(this._pinned);return Clutter.EVENT_STOP;}
            return Clutter.EVENT_PROPAGATE;
        });
        this._root.connect('notify::mapped',()=>{if(!this._root.mapped && this._press)this._endDrag(true);});
        this._root.connect('notify::hover', () => {
            if(this._press)return;
            if (this._root.hover) this._expand(true);
            else this._later(300, () => {if (!this._press && !this._root.hover && !this._pinned) this._expand(false);});
        });
        Main.layoutManager.addChrome(this._root,{affectsStruts:false,trackFullscreen:true});
        this._monitorId = Main.layoutManager.connect('monitors-changed', () => this._position());
        this._panelId = Main.panel.connect('notify::height', () => this._position());
        this._root.connect('notify::width', () => this._position());
        this._root.connect('notify::height', () => this._position());
        this._load(); this._resize(); this._position(); this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,120, () => {this._refresh();return GLib.SOURCE_CONTINUE;});
        this._clock = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,30, () => {if(!this._press)this._render();return GLib.SOURCE_CONTINUE;});
    }
    _later(ms, fn) {
        const id=GLib.timeout_add(GLib.PRIORITY_DEFAULT,ms,()=>{this._sources.delete(id);if(this._alive)fn();return GLib.SOURCE_REMOVE;});
        this._sources.add(id);return id;
    }
    _scale() { return this._settings.get_int('font-size') / 13; }
    _monitor(x,y) {
        return Main.layoutManager.monitors.find(m=>x>=m.x && x<m.x+m.width && y>=m.y && y<m.y+m.height) ?? Main.layoutManager.primaryMonitor;
    }
    _place(x,y) {
        const m=this._monitor(x,y);
        if(!m)return;
        this._root.set_position(Math.round(Math.max(m.x,Math.min(x,m.x+Math.max(0,m.width-this._root.width)))),
            Math.round(Math.max(m.y,Math.min(y,m.y+Math.max(0,m.height-this._root.height)))));
    }
    _position() {
        if(!this._root || this._press)return;
        if(this._settings.get_boolean('custom-position'))
            this._place(this._settings.get_int('position-x'),this._settings.get_int('position-y'));
        else {
            const m=Main.layoutManager.primaryMonitor;
            if(m)this._place(m.x+(m.width-this._root.width)/2,m.y+Main.panel.height+10);
        }
    }
    _beginDrag(x,y) {
        if(this._press)this._endDrag(true);
        this._press={x,y,actorX:this._root.x,actorY:this._root.y,dragged:false};
        this._grab=global.stage.grab(this._root);
        // Input capture stops at the grab actor. Release is handled on _root.
        // Bound any input grab even if the release event is lost.
        this._dragTimeout=this._later(10000,()=>{this._dragTimeout=null;this._endDrag(true);});
    }
    _moveDrag(x,y) {
        const p=this._press;
        if(!p)return;
        if(!p.dragged && Math.hypot(x-p.x,y-p.y)<6)return;
        if(!p.dragged)this._resize();
        p.dragged=true;
        this._root.remove_all_transitions();
        this._place(p.actorX+x-p.x,p.actorY+y-p.y);
    }
    _endDrag(cancel=false) {
        const p=this._press;if(!p)return;
        if(this._dragTimeout) {GLib.source_remove(this._dragTimeout);this._sources.delete(this._dragTimeout);this._dragTimeout=null;}
        this._press=null;
        this._grab?.dismiss();this._grab=null;
        if(cancel) {this._place(p.actorX,p.actorY);return;}
        if(p.dragged) {
            this._savingPosition=true;
            this._settings.set_int('position-x',Math.round(this._root.x));
            this._settings.set_int('position-y',Math.round(this._root.y));
            this._settings.set_boolean('custom-position',true);
            this._savingPosition=false;
            if(!this._root.hover && !this._pinned)this._expand(false);
        } else {this._pinned=!this._pinned;this._expand(this._pinned || this._root.hover);this._render();}
    }
    _fonts(actor=this._root,base=13) {
        const cls=actor.get_style_class_name?.()??'';
        if(cls.includes('ci-eyebrow') || cls.includes('ci-footer'))base=10;
        else if(cls.includes('ci-muted'))base=11;
        else if(cls.includes('ci-brand'))base=14;
        else if(cls.includes('ci-dot'))base=11;
        else if(cls.includes('ci-refresh'))base=12;
        if(actor instanceof St.Label)actor.set_style(`${(actor.get_style()??'').replace(/font-size:[^;]*;/g,'')}font-size:${Math.round(base*this._scale())}px;`);
        for(const child of actor.get_children())this._fonts(child,base);
    }
    _resize() {
        const scale=this._scale(),width=(this._open?352:300)*scale,head=44*scale;
        this._detail.set_style(`width:${304*scale}px;`);
        this._head.height=head;
        const [,natural]=this._detail.get_preferred_height(width);
        this._root.remove_all_transitions();
        this._root.set_size(width,this._open?head+natural+2:head);
    }
    _expand(open) {
        if(this._open===open)return;
        this._open=open;
        this._root.remove_all_transitions();this._detail.remove_all_transitions();
        if(open) {
            this._detail.show();this._render();this._detail.opacity=0;
            const scale=this._scale();
            const [,natural]=this._detail.get_preferred_height(352*scale);
            this._root.ease({width:352*scale,height:44*scale+natural+2,duration:260,mode:Clutter.AnimationMode.EASE_OUT_CUBIC});
            this._detail.ease({opacity:255,duration:220,mode:Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            this._root.ease({width:300*this._scale(),height:44*this._scale(),duration:220,mode:Clutter.AnimationMode.EASE_OUT_CUBIC});
            this._detail.ease({opacity:0,duration:130,mode:Clutter.AnimationMode.EASE_OUT_QUAD,onComplete:()=>{if(this._alive && !this._open)this._detail.hide();}});
        }
    }
    _load() {
        try {
            const f=Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(),'codex-island','usage.json']));
            const [ok,bytes]=f.load_contents(null);
            if(ok) {
                const data=JSON.parse(new TextDecoder().decode(bytes));
                if(!data || typeof data!=='object' || Array.isArray(data))throw new Error('invalid cache');
                data.windows=Array.isArray(data.windows)?data.windows.filter(w=>w && typeof w==='object').map(w=>({
                    minutes:Number.isFinite(w.minutes)&&w.minutes>0?w.minutes:null,
                    remaining:Number.isFinite(w.remaining)?Math.max(0,Math.min(100,w.remaining)):null,
                    resetsAt:Number.isFinite(w.resetsAt)?w.resetsAt:null,
                })):[];
                data.summary=data.summary && typeof data.summary==='object'?data.summary:{};
                data.daily=Array.isArray(data.daily)?data.daily.filter(b=>b && typeof b.startDate==='string' && typeof b.tokens==='number'):null;
                this._data=data;
            }
        } catch (_) {this._data={status:'unavailable'};}
        this._render();
    }
    _refresh() {
        if(this._busy || !this._alive)return;
        this._busy=true;
        try {
            this._proc=Gio.Subprocess.new(['/usr/bin/python3',`${this.path}/collector.py`],Gio.SubprocessFlags.STDOUT_SILENCE|Gio.SubprocessFlags.STDERR_SILENCE);
            this._proc.wait_async(null,(proc,res)=>{
                try {proc.wait_finish(res);} catch (_) {}
                if(this._proc!==proc)return;
                this._busy=false;this._proc=null;
                if(this._alive)this._load();
            });
        } catch (_) {this._busy=false;this._data.status='offline';this._render();}
    }
    _row(left,right,cls='ci-row') {
        const row=new St.BoxLayout({style_class:cls});
        row.add_child(new St.Label({text:left,x_expand:true}));row.add_child(new St.Label({text:right,style_class:'ci-value'}));
        this._detail.add_child(row);
    }
    _render() {
        const d=this._data, windows=d.windows ?? [], age=Date.now()/1000-(d.updatedAt??0);
        const stale=d.status!=='ok' || age>360;
        this._dot.set_style(`color:${stale?'#fbbf24':'#6ee7b7'};`);
        this._compact.set_text(windows.length ? windows.map(w=>`${w.minutes>=10080?'周':w.minutes?`${w.minutes/60}h`:'额度'} ${w.remaining===null?'—':`${Math.round(w.remaining)}%`}`).join('   ·   ') : '用量暂不可用');
        this._detail.destroy_all_children();
        this._row('USAGE OVERVIEW',this._pinned?'已固定':'悬停预览','ci-eyebrow');
        for(const w of windows) {
            this._row(windowName(w), w.remaining===null?'—':`剩余 ${Math.round(w.remaining)}%`);
            const track=new St.Widget({style_class:'ci-track',height:5,width:304*this._scale()});
            const n=w.remaining??0, color=n<=10?'#fb7185':n<=25?'#fbbf24':'#6ee7b7';
            if(w.remaining!==null)track.add_child(new St.Widget({height:5,width:Math.max(0,304*this._scale()*n/100),style:`background-color:${color};border-radius:3px;`}));
            this._detail.add_child(track);
            this._detail.add_child(new St.Label({text:countdown(w.resetsAt),style_class:'ci-muted ci-reset'}));
        }
        this._detail.add_child(new St.Widget({style_class:'ci-divider',height:1}));
        const today=new Date().toLocaleDateString('en-CA');
        const daily=d.daily, bucket=Array.isArray(daily)?daily.find(b=>b.startDate===today):null;
        this._row('今日 token（账户统计）',fmt(bucket?.tokens));
        this._row('累计 token（账户统计）',fmt(d.summary?.lifetimeTokens));
        const latest=Array.isArray(daily) && daily.length ? [...daily].sort((a,b)=>a.startDate.localeCompare(b.startDate)).at(-1) : null;
        this._row(latest ? `最近日统计 ${latest.startDate.slice(5)}` : '最近日统计',fmt(latest?.tokens));
        this._detail.add_child(new St.Label({text:'额度与 token 分别计量 · — 表示尚无数据',style_class:'ci-muted ci-note'}));
        const updated=d.updatedAt?new Date(d.updatedAt*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'尚未更新';
        this._row(stale?`● ${d.error==='codex_missing'?'未找到 Codex':d.error==='timeout'?'请求超时':'离线或数据过期'}`:'● 官方账户数据',`${updated} 更新`,'ci-footer');
        const refresh=new St.Button({label:'刷新用量 ↻',style_class:'ci-refresh',can_focus:true});
        refresh.connect('clicked',()=>this._refresh());this._detail.add_child(refresh);
        const controls=new St.BoxLayout({style_class:'ci-controls'});
        const smaller=new St.Button({label:'A−',style_class:'ci-adjust',can_focus:true,accessible_name:'缩小字号'});
        const size=new St.Label({text:`${this._settings.get_int('font-size')} px`,x_expand:true,y_align:Clutter.ActorAlign.CENTER});
        const larger=new St.Button({label:'A＋',style_class:'ci-adjust',can_focus:true,accessible_name:'放大字号'});
        smaller.reactive=this._settings.get_int('font-size')>12;
        larger.reactive=this._settings.get_int('font-size')<24;
        smaller.connect('clicked',()=>this._settings.set_int('font-size',Math.max(12,this._settings.get_int('font-size')-1)));
        larger.connect('clicked',()=>this._settings.set_int('font-size',Math.min(24,this._settings.get_int('font-size')+1)));
        controls.add_child(smaller);controls.add_child(size);controls.add_child(larger);this._detail.add_child(controls);
        const reset=new St.Button({label:'拖动顶部移动 · 点此恢复顶部居中',style_class:'ci-reset-position',can_focus:true});
        reset.connect('clicked',()=>this._settings.set_boolean('custom-position',false));this._detail.add_child(reset);
        this._fonts();
        if(this._open && !this._press)this._resize();
    }
    disable() {
        this._alive=false;
        this._press=null;this._grab?.dismiss();this._grab=null;
        if(this._captureId)this._root.disconnect(this._captureId);
        if(this._settingsId)this._settings.disconnect(this._settingsId);
        for(const id of this._sources)GLib.source_remove(id);
        this._sources.clear();
        for(const id of [this._timer,this._clock])if(id)GLib.source_remove(id);
        if(this._monitorId)Main.layoutManager.disconnect(this._monitorId);
        if(this._panelId)Main.panel.disconnect(this._panelId);
        if(this._proc){try{this._proc.send_signal(15);}catch(_){}this._proc=null;}
        this._busy=false;
        this._root.destroy();this._root=null;
    }
}
