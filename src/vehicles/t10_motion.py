"""Gallery worker adapter. Integrates the unchanged shared fixed-step driving core."""
from drive_core import Driver
class Runtime:
    def __init__(self, config):
        self.config=config
        self.driver=Driver({'gauge':config['gauge']})
        self.inputs={}
    def step(self,events,elapsed):
        d=self.driver
        for event,value in events:
            if event=='input': self.inputs=value
            elif event=='mouse': d.mouse(*value)
            elif event=='fire' and self.inputs.get('enabled'): d.fire()
            elif event=='hatch': d.hatches_open=not d.hatches_open
            elif event=='reset': self.driver=d=Driver({'gauge':self.config['gauge']})
        i=self.inputs;active=i.get('enabled',False)
        d.advance(elapsed,i.get('throttle',0) if active else 0,i.get('steer',0) if active else 0,
                  i.get('brake',False) or not active,self.config['terrain'])
        eye,aim=d.camera((d.x,d.y,d.z))
        array=[d.x,d.y,d.heading,d.left,d.right,*d.travel,d.turret,d.elevation,d.recoil,d.flash,d.shots,
               eye,aim,d.hatch,d.z,d.pitch,d.roll,d.suspension,d.grounded,d.speed,d.braking]
        state={k:getattr(d,k) for k in ('x','y','z','heading','speed','pitch','roll','suspension','grounded','braking','shots','turret','elevation','hatch')}
        return {'state':state,'array':array}
def create_runtime(config):
    return Runtime(config)
