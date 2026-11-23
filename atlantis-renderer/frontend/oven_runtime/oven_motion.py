# Generated from oven_core.py and oven_adapter.py. Rebuild with verify_oven_controls_step12.py.
"""Reproducible game-level electric oven. Pure stdlib, SI units except Celsius.
This lumped heat model is a controllable approximation, not an engineering solver.
"""
from dataclasses import dataclass, asdict, fields
import math

MODES = ('OFF', 'BAKE', 'FAN', 'GRILL', 'LIGHT')
THERMAL_MODES = ('BAKE', 'FAN', 'GRILL')

def number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(name + ' must be a finite number')
    return float(value)

def clamp(value, low, high):
    return max(low, min(high, value))

@dataclass(frozen=True)
class Parameters:
    fixed_dt_s: float = 1.0 / 120.0
    max_frame_dt_s: float = 60.0
    ambient_C: float = 20.0
    heat_capacity_J_K: float = 8500.0
    closed_loss_W_K: float = 5.5
    open_extra_loss_W_K: float = 65.0
    cooling_extra_loss_W_K: float = 2.0
    bake_power_W: float = 2300.0
    fan_power_W: float = 2000.0
    grill_power_W: float = 2200.0
    hysteresis_C: float = 2.5
    cooling_on_C: float = 60.0
    cooling_off_C: float = 45.0
    overtemperature_C: float = 315.0
    door_max_rad: float = math.pi / 2.0
    door_access_rad: float = 1.45
    slide_max_m: float = 0.18
    door_speed_rad_s: float = 0.9
    slide_speed_m_s: float = 0.15
    circulation_speed_rad_s: float = 35.0
    cooling_speed_rad_s: float = 45.0
    max_timer_s: float = 86400.0

    def __post_init__(self):
        for item in fields(self):
            number(getattr(self, item.name), item.name)
        limits = {
            'fixed_dt_s': (1.0 / 1000.0, 1.0 / 30.0), 'max_frame_dt_s': (1.0, 60.0),
            'ambient_C': (-20.0, 45.0), 'heat_capacity_J_K': (1000.0, 100000.0),
            'closed_loss_W_K': (0.1, 50.0), 'open_extra_loss_W_K': (0.0, 200.0),
            'cooling_extra_loss_W_K': (0.0, 50.0), 'bake_power_W': (0.0, 5000.0),
            'fan_power_W': (0.0, 5000.0), 'grill_power_W': (0.0, 5000.0),
            'hysteresis_C': (0.1, 20.0), 'cooling_on_C': (46.0, 100.0),
            'cooling_off_C': (30.0, 60.0), 'overtemperature_C': (290.0, 350.0),
            'door_access_rad': (1.3, math.pi / 2.0), 'door_speed_rad_s': (0.01, 5.0),
            'slide_speed_m_s': (0.001, 1.0), 'circulation_speed_rad_s': (0.0, 200.0),
            'cooling_speed_rad_s': (0.0, 200.0), 'max_timer_s': (1.0, 86400.0)
        }
        for key, (low, high) in limits.items():
            if not low <= getattr(self, key) <= high:
                raise ValueError('Parameter outside documented range: ' + key)
        if self.door_max_rad != math.pi / 2 or self.slide_max_m != 0.18:
            raise ValueError('Asset travel must stay pi/2 rad and 0.18 m')
        if not self.ambient_C < self.cooling_off_C < self.cooling_on_C:
            raise ValueError('Cooling thresholds must exceed ambient and be ordered')

@dataclass
class State:
    mode: str = 'OFF'
    setpoint_C: float = 180.0
    timer_duration_s: float = 0.0
    timer_remaining_s: float = 0.0
    timer_enabled: bool = False
    running: bool = False
    completed: bool = False
    alarm: bool = False
    trip: str = ''
    temperature_C: float = 20.0
    heater_on: bool = False
    thermostat_latch: bool = False
    circulation_fan_on: bool = False
    cooling_fan_on: bool = False
    lamp_manual: bool = False
    lamp_on: bool = False
    door_rad: float = 0.0
    door_target_rad: float = 0.0
    rack_m: float = 0.0
    rack_target_m: float = 0.0
    tray_m: float = 0.0
    tray_target_m: float = 0.0
    fan_angle_rad: float = 0.0
    cooling_angle_rad: float = 0.0
    ticks: int = 0
    accumulator_s: float = 0.0
    energy_input_J: float = 0.0
    heat_loss_J: float = 0.0

class Oven:
    schema = 'atlantis-oven-state/1'

    def __init__(self, parameters=None):
        self.p = parameters if isinstance(parameters, Parameters) else Parameters(**(parameters or {}))
        self.s = State(temperature_C=self.p.ambient_C)
        self._outputs()

    def command(self, name, value=None):
        s, p = self.s, self.p
        if name == 'mode':
            if value not in MODES:
                raise ValueError('Unknown mode')
            s.mode = value
            if value == 'OFF':
                s.running = False
                s.thermostat_latch = False
        elif name == 'temperature_C':
            s.setpoint_C = clamp(number(value, name), 50.0, 275.0)
        elif name == 'timer_s':
            duration = clamp(number(value, name), 0.0, p.max_timer_s)
            s.timer_duration_s = s.timer_remaining_s = duration
            s.timer_enabled = duration > 0.0
            s.completed = s.alarm = False
        elif name == 'start':
            if s.mode == 'OFF' or s.trip:
                raise ValueError('Select a mode and clear any trip before starting')
            if s.timer_enabled and s.timer_remaining_s <= 0.0:
                s.timer_remaining_s = s.timer_duration_s
            s.running = True
            s.completed = s.alarm = False
        elif name == 'stop':
            s.running = s.thermostat_latch = s.alarm = False
        elif name == 'ack':
            s.alarm = s.completed = False
        elif name == 'lamp':
            if not isinstance(value, bool):
                raise ValueError('lamp requires boolean')
            s.lamp_manual = value
        elif name == 'door':
            target = clamp(number(value, name), 0.0, p.door_max_rad)
            if target < p.door_access_rad and max(s.rack_m, s.rack_target_m, s.tray_m, s.tray_target_m) > 1e-7:
                raise ValueError('Retract rack and tray before closing door')
            s.door_target_rad = target
        elif name in ('rack', 'tray'):
            target = clamp(number(value, name), 0.0, p.slide_max_m)
            if target > 1e-7 and (s.door_rad < p.door_access_rad or s.door_target_rad < p.door_access_rad):
                raise ValueError('Open door before extending rack or tray')
            setattr(s, name + '_target_m', target)
        else:
            raise ValueError('Unknown event: ' + str(name))
        self._outputs()

    def _outputs(self):
        s, p = self.s, self.p
        if s.temperature_C >= p.overtemperature_C:
            s.trip = 'OVERTEMPERATURE'
            s.running = s.thermostat_latch = False
            s.alarm = True
        enabled = s.running and s.mode in THERMAL_MODES and not s.trip
        if not enabled:
            s.thermostat_latch = False
        elif s.temperature_C <= s.setpoint_C - p.hysteresis_C:
            s.thermostat_latch = True
        elif s.temperature_C >= s.setpoint_C + p.hysteresis_C:
            s.thermostat_latch = False
        s.heater_on = enabled and s.thermostat_latch
        s.circulation_fan_on = s.running and s.mode == 'FAN'
        if enabled or s.temperature_C >= p.cooling_on_C:
            s.cooling_fan_on = True
        elif s.temperature_C <= p.cooling_off_C:
            s.cooling_fan_on = False
        s.lamp_on = s.lamp_manual or s.door_rad > 0.02 or (s.running and s.mode != 'OFF')

    def thermal_coefficients(self):
        s, p = self.s, self.p
        fraction = math.sin(s.door_rad) ** 1.2
        loss = p.closed_loss_W_K + p.open_extra_loss_W_K * fraction
        if s.cooling_fan_on:
            loss += p.cooling_extra_loss_W_K
        powers = {'BAKE': p.bake_power_W, 'FAN': p.fan_power_W, 'GRILL': p.grill_power_W}
        power = powers.get(s.mode, 0.0) if s.heater_on else 0.0
        return power, loss

    def _tick(self):
        s, p = self.s, self.p
        h = p.fixed_dt_s
        for current, target, speed in [('door_rad', 'door_target_rad', p.door_speed_rad_s), ('rack_m', 'rack_target_m', p.slide_speed_m_s), ('tray_m', 'tray_target_m', p.slide_speed_m_s)]:
            position, goal = getattr(s, current), getattr(s, target)
            delta = clamp(goal - position, -speed * h, speed * h)
            setattr(s, current, goal if abs(goal-position) <= speed*h else position+delta)
        self._outputs()
        active_h = min(h, s.timer_remaining_s) if s.running and s.timer_enabled else h
        power, loss = self.thermal_coefficients()
        old = s.temperature_C
        # Exact solution of C*dT/dt=P-UA*(T-ambient) over this fixed substep.
        def integrate(temperature, watts, elapsed):
            factor = -math.expm1(-loss * elapsed / p.heat_capacity_J_K)
            return temperature + (p.ambient_C + watts / loss - temperature) * factor
        s.temperature_C = integrate(old, power, active_h)
        if active_h < h:
            s.temperature_C = integrate(s.temperature_C, 0.0, h-active_h)
        added = power * active_h
        s.energy_input_J += added
        s.heat_loss_J += added - p.heat_capacity_J_K*(s.temperature_C-old)
        if s.running and s.timer_enabled:
            s.timer_remaining_s = max(0.0, s.timer_remaining_s - h)
            if s.timer_remaining_s <= 1e-10:
                s.timer_remaining_s = 0.0
                s.running = s.thermostat_latch = False
                s.completed = s.alarm = True
        s.fan_angle_rad = (s.fan_angle_rad + (p.circulation_speed_rad_s*h if s.circulation_fan_on else 0.0)) % math.tau
        s.cooling_angle_rad = (s.cooling_angle_rad + (p.cooling_speed_rad_s*h if s.cooling_fan_on else 0.0)) % math.tau
        s.ticks += 1
        self._outputs()

    def advance(self, dt_s):
        dt = number(dt_s, 'dt_s')
        if not 0.0 <= dt <= self.p.max_frame_dt_s:
            raise ValueError('dt_s must be in [0,max_frame_dt_s]; no elapsed time is silently discarded')
        s, h = self.s, self.p.fixed_dt_s
        total = s.accumulator_s + dt
        count = int((total + 1e-12) / h)
        s.accumulator_s = max(0.0, total-count*h)
        for _ in range(count):
            self._tick()
        return self.snapshot()

    def snapshot(self):
        data = asdict(self.s)
        data['elapsed_s'] = self.s.ticks * self.p.fixed_dt_s
        data['mode_knob_rad'] = MODES.index(self.s.mode) * 1.1
        data['temperature_knob_rad'] = (self.s.setpoint_C-50.0) / 225.0 * 4.4
        data['display'] = '%03dC %02d:%02d' % (round(self.s.temperature_C), math.ceil(self.s.timer_remaining_s)//60, math.ceil(self.s.timer_remaining_s)%60)
        data['power_W'], data['loss_W_K'] = self.thermal_coefficients()
        return data

    def serialize(self):
        return {'schema': self.schema, 'parameters': asdict(self.p), 'state': asdict(self.s)}

    @classmethod
    def restore(cls, saved):
        if saved.get('schema') != cls.schema:
            raise ValueError('Unsupported saved-state schema')
        oven = cls(saved['parameters'])
        state = saved['state']
        if set(state) != {f.name for f in fields(State)}:
            raise ValueError('Saved state must contain every field exactly once')
        for item in fields(State):
            value = state[item.name]
            if item.type is bool:
                if not isinstance(value, bool): raise ValueError('Invalid boolean ' + item.name)
            elif item.type is float:
                number(value, item.name)
        oven.s = State(**state)
        s, p = oven.s, oven.p
        if s.mode not in MODES or s.trip not in ('', 'OVERTEMPERATURE'):
            raise ValueError('Invalid saved mode/trip')
        if isinstance(s.ticks,bool) or not isinstance(s.ticks,int) or s.ticks < 0:
            raise ValueError('Invalid saved tick count')
        checks = [('setpoint_C',50,275),('timer_duration_s',0,p.max_timer_s),('timer_remaining_s',0,p.max_timer_s),('temperature_C',p.ambient_C,p.overtemperature_C+1),('accumulator_s',0,p.fixed_dt_s),('door_rad',0,p.door_max_rad),('door_target_rad',0,p.door_max_rad),('rack_m',0,p.slide_max_m),('rack_target_m',0,p.slide_max_m),('tray_m',0,p.slide_max_m),('tray_target_m',0,p.slide_max_m),('fan_angle_rad',0,math.tau),('cooling_angle_rad',0,math.tau),('energy_input_J',0,1e18),('heat_loss_J',0,1e18)]
        for key,low,high in checks:
            if not low <= getattr(s,key) <= high: raise ValueError('Saved state outside range: '+key)
        if s.timer_remaining_s > s.timer_duration_s or s.timer_enabled != (s.timer_duration_s > 0):
            raise ValueError('Inconsistent saved timer')
        if max(s.rack_m,s.rack_target_m,s.tray_m,s.tray_target_m)>1e-7 and min(s.door_rad,s.door_target_rad)<p.door_access_rad:
            raise ValueError('Inconsistent saved door/slide state')
        derived = (s.heater_on,s.circulation_fan_on,s.cooling_fan_on,s.lamp_on,s.thermostat_latch,s.running,s.alarm)
        oven._outputs()
        if derived != (s.heater_on,s.circulation_fan_on,s.cooling_fan_on,s.lamp_on,s.thermostat_latch,s.running,s.alarm):
            raise ValueError('Saved output flags are inconsistent')
        return oven

"""Host-independent event/snapshot adapter. No viewer, OS or engine imports."""

class Runtime:
    def __init__(self, config=None):
        config = config or {}
        self.oven = Oven.restore(config['saved']) if 'saved' in config else Oven(config.get('parameters'))

    def step(self, events, dt_s):
        # Validate a complete event batch and dt on a clone before committing.
        candidate = Oven.restore(self.oven.serialize())
        errors = []
        for event in events:
            if not isinstance(event, (list, tuple)) or not 1 <= len(event) <= 2:
                raise ValueError('Events must be [name,value] pairs')
            try:
                candidate.command(event[0], event[1] if len(event)==2 else None)
            except ValueError as error:
                errors.append({'event':event[0], 'error':str(error)})
        snapshot = candidate.advance(dt_s)
        self.oven = candidate
        snapshot['event_errors'] = errors
        snapshot['joints'] = {
            'oven_door': snapshot['door_rad'], 'rack_slide': snapshot['rack_m'],
            'tray_slide': snapshot['tray_m'], 'fan_rotor': snapshot['fan_angle_rad'],
            'cooling_rotor': snapshot['cooling_angle_rad'],
            'mode_control': snapshot['mode_knob_rad'], 'temp_control':snapshot['temperature_knob_rad']}
        snapshot['heater_channels'] = {
            'upper_heater':snapshot['heater_on'] and snapshot['mode'] in ('BAKE','GRILL'),
            'lower_heater':snapshot['heater_on'] and snapshot['mode']=='BAKE',
            'ring_heater':snapshot['heater_on'] and snapshot['mode']=='FAN'}
        return snapshot

    def serialize(self):
        return self.oven.serialize()

def create_runtime(config=None):
    return Runtime(config)

"""Physical panel actions translated into core events; designed for appending to oven_motion.py."""
_PortableRuntime = Runtime


def validate_dial_calibration(value):
    if not isinstance(value, dict):
        raise ValueError("Invalid oven dial calibration")
    modes = value.get("mode_clockwise_deg")
    if not isinstance(modes, dict) or set(modes) != set(MODES):
        raise ValueError("Expected one dial angle for every oven mode")
    modes = {mode: number(modes[mode], mode) for mode in MODES}
    if modes["OFF"] != 0 or any(deg < 0 or deg >= 360 for deg in modes.values()) or len(set(modes.values())) != len(modes):
        raise ValueError("Invalid oven mode detents")

    marks = value.get("temperature_clockwise_deg")
    if not isinstance(marks, list) or not 2 <= len(marks) <= 64:
        raise ValueError("Expected oven temperature calibration marks")
    points = []
    for mark in marks:
        if not isinstance(mark, (list, tuple)) or len(mark) != 2:
            raise ValueError("Each temperature mark needs a temperature and angle")
        temp, angle = (number(v, "temperature calibration") for v in mark)
        if not 0 <= angle < 360 or (points and (temp <= points[-1][0] or angle <= points[-1][1])):
            raise ValueError("Temperature marks must increase clockwise")
        points.append([temp, angle])
    if points[0][0] != 50 or points[-1][0] != 275:
        raise ValueError("Oven dial must cover the 50 to 275 Celsius setpoint range")
    return {"mode_clockwise_deg": modes, "temperature_clockwise_deg": points}


class PanelRuntime(_PortableRuntime):
    def __init__(self, config=None):
        config = config or {}
        super().__init__(config)
        calibrations = [
            validate_dial_calibration(source[key])
            for source, key in ((config, "dial_calibration"), (config, "asset_dial_calibration"),
                                (config.get("saved", {}), "dial_calibration"))
            if key in source
        ]
        self.calibration = calibrations[0] if calibrations else None
        if any(item != self.calibration for item in calibrations):
            raise ValueError("Scene, oven asset and saved dial calibrations disagree")
        self.mode_order = MODES
        if self.calibration:
            angles = self.calibration["mode_clockwise_deg"]
            self.mode_order = tuple(sorted(angles, key=angles.get))

    def serialize(self):
        result = super().serialize()
        if self.calibration:
            result["dial_calibration"] = self.calibration
        return result

    def apply_dial_calibration(self, state):
        mode = self.calibration["mode_clockwise_deg"][state["mode"]]
        marks = self.calibration["temperature_clockwise_deg"]
        temp = state["setpoint_C"]
        for (lo, a), (hi, b) in zip(marks, marks[1:]):
            if temp <= hi:
                clockwise = a + (b - a) * (temp - lo) / (hi - lo)
                break
        # The temperature pointer in the bind pose is already at the first mark.
        state["mode_knob_rad"] = state["joints"]["mode_control"] = math.radians(mode)
        state["temperature_knob_rad"] = state["joints"]["temp_control"] = math.radians(clockwise - marks[0][1])
        state["dial_calibration"] = self.calibration

    def step(self, events, dt_s):
        # Apply dependent clicks in order, including two detents in the same frame.
        saved=self.oven.serialize()
        errors=[]
        try:
            for name,value in events:
                s=self.oven.s
                if name=='mode_next':
                    name,value='mode',self.mode_order[(self.mode_order.index(s.mode)+1)%len(self.mode_order)]
                elif name=='temp_next':
                    options=(50,100,150,180,200,250,275)
                    name,value='temperature_C',next((t for t in options if t>s.setpoint_C),50)
                elif name=='timer_next':
                    name,value='timer_s',next((t for t in (60,300,600,1800,3600) if t>s.timer_duration_s),0)
                elif name=='door_toggle': name,value='door',0 if s.door_target_rad>.1 else self.oven.p.door_max_rad
                elif name in ('rack_toggle','tray_toggle'):
                    part=name.split('_')[0];name,value=part,0 if getattr(s,part+'_target_m')>.01 else self.oven.p.slide_max_m
                elif name=='lamp_toggle': name,value='lamp',not s.lamp_manual
                try: self.oven.command(name,value)
                except ValueError as error: errors.append({'event':name,'error':str(error)})
            result=super().step([],dt_s)
            if self.calibration:
                self.apply_dial_calibration(result)
            result['event_errors']=errors
            if errors:result['display']+=' | '+errors[-1]['error']
            return result
        except Exception:
            self.oven=Oven.restore(saved)
            raise
def create_runtime(config=None):
    return PanelRuntime(config)

