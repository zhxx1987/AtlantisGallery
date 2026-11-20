"""Portable game vehicle motion. Python standard library only; metres/radians/seconds.

Simplified ground contacts, bounded suspension and procedural closed tracks.
Native PhysX uses its own independent controller. Hosts draw these local poses.
"""
import bisect
import copy
import math


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def wrap(x):
    return math.atan2(math.sin(x), math.cos(x))


def approach(x, target, amount):
    return x + clamp(target - x, -amount, amount)


def matrix(position=(0, 0, 0), axis=(0, 0, 1), angle=0):
    x, y, z = axis
    c, s, t = math.cos(angle), math.sin(angle), 1 - math.cos(angle)
    return [t*x*x+c, t*x*y+s*z, t*x*z-s*y, 0,
            t*x*y-s*z, t*y*y+c, t*y*z+s*x, 0,
            t*x*z+s*y, t*y*z-s*x, t*z*z+c, 0,
            *position, 1]


def multiply(a, b):
    return [sum(a[k*4+r] * b[c*4+k] for k in range(4))
            for c in range(4) for r in range(4)]


class Vehicle:
    def __init__(self, config):
        self.config = copy.deepcopy(config)
        self.path = config['path_xz']
        self.arc = [0.0]
        for a, b in zip(self.path, self.path[1:] + self.path[:1]):
            self.arc.append(self.arc[-1] + math.hypot(b[0]-a[0], b[1]-a[1]))
        self.roads = []
        for wheel in config['wheels']:
            if not wheel['name'].startswith('roadwheel_'): continue
            arm = wheel['name'].replace('roadwheel_', 'suspension_')
            pivot = config['rest'][arm][12:15]
            offset = wheel['rest'][12:15]
            self.roads.append(dict(name=wheel['name'], arm=arm, side=wheel['side'],
                                   pivot=pivot, offset=offset,
                                   x=pivot[0]+offset[0], y=pivot[1]+offset[1]))
        self.ride = {**dict(spring=36., damping=8.6, droop=.055, travel=.085,
                         coast=.9, braking=7.5), **config.get('suspension', {})}
        self.link_lengths={link['name']:math.dist(self.point(link['start']),self.point(link['end']))
                           for links in config['links'].values() for link in links}
        self.reset()

    def reset(self):
        self.state = dict(time=0., x=0., y=0., yaw=0., left_speed=0., right_speed=0.,
                          left_distance=0., right_distance=0., turret=0., elevation=0., joints={},
                          speed=0., omega=0., acceleration=0., z=0., vz=0., pitch=0., roll=0.,
                          pitch_velocity=0., roll_velocity=0., accumulator=0., braking=True,
                          reverse_braking=False, grounded=len(self.roads),
                          contacts=[True]*len(self.roads), suspension=[0.]*len(self.roads),
                          arm_angles=[0.]*len(self.roads))
        self.inputs = dict(throttle=0., steer=0., aim_yaw=0., elevation=0., brake=False, enabled=False)

    def save(self):
        return copy.deepcopy(dict(schema='atlantis-vehicle-state/1', state=self.state, inputs=self.inputs))

    def restore(self, saved):
        if saved.get('schema') != 'atlantis-vehicle-state/1':
            raise ValueError('Unsupported vehicle state')
        candidate = copy.deepcopy(saved)
        for value in list(candidate['state'].values()) + list(candidate['inputs'].values()):
            if isinstance(value, (float, int)) and not math.isfinite(value):
                raise ValueError('State contains non-finite value')
        self.reset()
        self.state.update(candidate['state']); self.inputs.update(candidate['inputs'])

    def advance(self, dt):
        if not isinstance(dt, (int, float)) or not math.isfinite(dt) or dt < 0 or dt > .25:
            raise ValueError('dt must be finite and in [0, .25] seconds')
        self.state['accumulator'] += dt
        while self.state['accumulator'] + 1e-12 >= 1/120:
            self._advance(1/120)
            self.state['accumulator'] -= 1/120

    def _advance(self, dt):
        c, s, i = self.config, self.state, self.inputs
        throttle = clamp(float(i['throttle']), -1, 1) if i['enabled'] else 0
        steer = clamp(float(i['steer']), -1, 1) if i['enabled'] else 0
        stopping = s['reverse_braking'] and any(abs(s[k])>1e-10 for k in ('speed','left_speed','right_speed'))
        s['reverse_braking'] = bool(throttle and (throttle*s['speed'] < -1e-10 or stopping))
        s['braking'] = bool(i.get('brake') or not i['enabled'] or s['reverse_braking'])
        left, right = throttle-steer, throttle+steer
        scale = max(1., abs(left), abs(right))
        for side, demand in zip(('left', 'right'), (left/scale, right/scale)):
            target = demand * (c['forward_speed'] if demand >= 0 else c['reverse_speed'])
            old = s[side+'_speed']
            if s['braking']: target = 0.
            rate = self.ride['braking'] if s['braking'] else c['acceleration'] if target else self.ride['coast']
            new = approach(old, target, rate*dt)
            distance = (old+new)*.5*dt
            s[side+'_speed'] = new
            s[side+'_distance'] += distance
        traction = s['grounded']/len(self.roads)
        old = s['speed']
        rate = self.ride['braking'] if s['braking'] else c['acceleration'] if throttle else self.ride['coast']
        s['speed'] = approach(old, (s['left_speed']+s['right_speed'])*.5, rate*traction*dt)
        s['omega'] = approach(s['omega'], (s['right_speed']-s['left_speed'])/c['track_gauge'], 3*traction*dt)
        s['acceleration'] = (s['speed']-old)/dt
        ds = (old+s['speed'])*.5*dt
        dyaw = s['omega']*dt
        # Exact constant-curvature midpoint integration, stable at zero turn.
        factor = math.sin(dyaw*.5)/(dyaw*.5) if abs(dyaw) > 1e-10 else 1.
        s['x'] += ds*factor*math.cos(s['yaw']+dyaw*.5)
        s['y'] += ds*factor*math.sin(s['yaw']+dyaw*.5)
        s['yaw'] = wrap(s['yaw']+dyaw)
        self.ride_step(dt)
        error = wrap(float(i['aim_yaw'])-s['yaw']-s['turret'])
        s['turret'] = wrap(s['turret'] + clamp(error*3., -c['turret_rate'], c['turret_rate'])*dt)
        goal = clamp(float(i['elevation']), c['gun_min'], c['gun_max'])
        s['elevation'] = approach(s['elevation'], goal, c['gun_rate']*dt)
        for name, target in i.get('joints', {}).items():
            joint = c['hinges'].get(name)
            if joint:
                s['joints'][name] = approach(s['joints'].get(name, 0), clamp(target, *joint['limits']), joint['speed']*dt)
        s['time'] += dt

    def ground_height(self, x, y):
        terrain = self.config.get('terrain', {})
        h = terrain.get('floor', 0.)
        for patch in terrain.get('patches', []):
            a,b,height,center,width = patch
            if a < x < b and abs(y-center)<width:
                edge=clamp((width-abs(y-center))/.4,0,1)
                h=max(h,terrain.get('floor',0.)+height*math.sin(math.pi*(x-a)/(b-a))**2*edge)
        return h

    def arm_pose(self, road, delta):
        x,y,z = road['offset']; radius=math.hypot(x,z)
        angle=math.asin(clamp((z+delta)/radius,-1,1))-math.atan2(z,-x)
        angle=clamp(angle,*self.config['hinges'][road['arm']]['limits'])
        return angle, x*math.cos(angle)+z*math.sin(angle), -x*math.sin(angle)+z*math.cos(angle)

    def ride_step(self, dt):
        s=self.state; r=self.ride; n=len(self.roads)
        c,sn=math.cos(s['yaw']),math.sin(s['yaw'])
        cx=sum(w['x'] for w in self.roads)/n
        xx=sum((w['x']-cx)**2 for w in self.roads)/n
        yy=sum(w['y']**2 for w in self.roads)/n
        force=pf=rf=0.
        for j,w in enumerate(self.roads):
            x,y=w['x'],w['y']
            h=self.ground_height(s['x']+c*x-sn*y,s['y']+sn*x+c*y)
            body=s['z']+x*math.sin(s['pitch'])+y*math.sin(s['roll'])
            delta=h-body; contact=delta>=-r['droop']
            s['contacts'][j]=contact
            angle,_,z=self.arm_pose(w,clamp(delta,-r['droop'],r['travel']))
            s['arm_angles'][j]=angle; s['suspension'][j]=z-w['offset'][2]
            velocity=s['vz']+x*s['pitch_velocity']+y*s['roll_velocity']
            load=clamp(9.81+r['spring']*delta-r['damping']*velocity,0,65) if contact else 0
            load+=min(120,max(0,delta-r['travel'])*350)
            force+=load/n; pf+=(x-cx)*load/(n*xx); rf+=y*load/(n*yy)
        s['grounded']=sum(s['contacts'])
        s['vz']+=(force-9.81)*dt; s['z']+=s['vz']*dt
        transfer=clamp(s['acceleration']*.009,-.065,.025)*s['grounded']/n
        s['pitch_velocity']+=(pf+r['spring']*transfer)*dt
        s['roll_velocity']+=(rf-clamp(s['speed']*s['omega']*.012,-.06,.06)*r['spring']*s['grounded']/n)*dt
        s['pitch']=clamp(s['pitch']+s['pitch_velocity']*dt,-.32,.32)
        s['roll']=clamp(s['roll']+s['roll_velocity']*dt,-.25,.25)

    def point(self, distance):
        d = distance % self.arc[-1]
        j = min(len(self.path)-1, bisect.bisect_right(self.arc, d)-1)
        a, b = self.path[j], self.path[(j+1) % len(self.path)]
        u = (d-self.arc[j]) / max(1e-12, self.arc[j+1]-self.arc[j])
        return [a[k]+(b[k]-a[k])*u for k in (0, 1)]

    def track_point(self, distance, wheels):
        x,z=self.point(distance)
        j=clamp(bisect.bisect_right([w[0] for w in wheels],x)-1,0,len(wheels)-2)
        a,b=wheels[j:j+2]; u=clamp((x-a[0])/(b[0]-a[0]),0,1)
        # Fade deformation away from the lower run and before either fixed end wheel.
        edge=clamp((x-(wheels[0][0]-.55))/.55,0,1)*clamp(((wheels[-1][0]+.55)-x)/.55,0,1)
        z+=(a[1]+(b[1]-a[1])*u)*clamp((-.05-z)/.35,0,1)*edge
        return x,z

    def poses(self):
        c, s = self.config, self.state
        hull=matrix((s['x'],s['y'],c['ground_lift']+s['z']),angle=s['yaw'])
        hull=multiply(hull,matrix(axis=(0,1,0),angle=-s['pitch']))
        out = {'hull': multiply(hull,matrix(axis=(1,0,0),angle=s['roll']))}
        out['turret_yaw'] = multiply(c['rest']['turret_yaw'], matrix(angle=s['turret']))
        out['gun_elevation'] = multiply(c['rest']['gun_elevation'], matrix(axis=(0, 1, 0), angle=-s['elevation']))
        for wheel in c['wheels']:
            side = 'left' if wheel['side'] == 'L' else 'right'
            arm=next((s['arm_angles'][j] for j,w in enumerate(self.roads) if w['name']==wheel['name']),0.)
            out[wheel['name']] = multiply(wheel['rest'], matrix(axis=(0, 1, 0), angle=s[side+'_distance']/wheel['radius']-arm))
        for name, hinge in c['hinges'].items():
            angle = s['joints'].get(name, 0.)
            out[name] = multiply(c['rest'][name], matrix(axis=hinge['axis'], angle=angle))
        for j,w in enumerate(self.roads):
            out[w['arm']]=multiply(c['rest'][w['arm']],matrix(axis=(0,1,0),angle=s['arm_angles'][j]))
        for side, label in (('left', 'L'), ('right', 'R')):
            phase = s[side+'_distance']
            wheels=[]
            for j,w in enumerate(self.roads):
                if w['side']==label:
                    angle=s['arm_angles'][j]
                    ox=w['offset'][0]*math.cos(angle)+w['offset'][2]*math.sin(angle)
                    wheels.append((w['pivot'][0]+ox,s['suspension'][j]))
            wheels.sort()
            for link in c['links'][label]:
                a, b = self.track_point(link['start']+phase,wheels), self.track_point(link['end']+phase,wheels)
                dx, dz = b[0]-a[0], b[1]-a[1]
                length = math.hypot(dx, dz)
                tx,tz=dx/length,dz/length; scale=length/self.link_lengths[link['name']]
                out[link['name']] = [tx*scale, 0, tz*scale, 0, 0, 1, 0, 0, -tz, 0, tx, 0,
                                     (a[0]+b[0])*.5, 0, (a[1]+b[1])*.5, 1]
        return out

    def snapshot(self):
        return dict(schema='atlantis-vehicle-frame/1', state=copy.deepcopy(self.state), matrices=self.poses())

    def step(self, events, elapsed):
        for name, value in events:
            if name == 'reset':
                self.reset()
            elif name == 'input':
                for key in ('throttle', 'steer', 'aim_yaw', 'elevation', 'enabled', 'brake'):
                    if key in value:
                        self.inputs[key] = value[key]
            elif name == 'joint':
                self.inputs.setdefault('joints', {})[value['name']] = float(value['angle'])
            elif name == 'restore':
                self.restore(value)
        self.advance(elapsed)
        return self.snapshot()


def create_runtime(config):
    return Vehicle(config)
