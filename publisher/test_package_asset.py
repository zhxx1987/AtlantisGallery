"""Check archive roles, explicit closure, runtime validation and deterministic plans."""
import hashlib, json, sys, tempfile
from pathlib import Path
from zipfile import ZipFile
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from publisher.package_asset import stage_package,catalog_entry,add_to_catalog,check_catalog_slot

def run_check():
    with tempfile.TemporaryDirectory() as folder:
        root=Path(folder)
        files={'tank.glb':b'glb fixture','tank.usda':b'#usda 1.0', 'thumb.webp':b'fixture',
            'controller.js':b'export async function install(context) { return {}; }', 'motion.py':b'def step(dt): return dt\n',
            'native.py':b'# native entry\n','build.py':b'# editable geometry\n',
            'config.json':b'{}','texture.png':b'texture','secret.txt':b'NOT PUBLIC',
            'order.json':b'{"approved":true}',
            'isaac-runtimes.json':json.dumps({'modes':{'real-physics':{'entry':'native.py','usd':'tank.usda'}}}).encode()}
        for name,content in files.items():(root/name).write_bytes(content)
        data={'schema':'atlantis-gallery-submission/1','slug':'test-tank','title':'Test Tank','creator':'Test',
            'model':'tank.glb','thumbnail':'thumb.webp','operableVehicle':True,'vehicleController':{'schema':'atlantis-gallery-vehicle/1','module':'controller.js','renderer':'gallery-shared','thirdPersonCursor':'hidden'},
            'previewFiles':['motion.py','texture.png','controller.js'], 'modelFiles':['tank.usda'],
            'motionFiles':['native.py'], 'controlFiles':['config.json','isaac-runtimes.json'],
            'sourceFiles':['build.py'],'workOrder':'order.json','isaacRuntimes':['real-physics']}
        manifest=root/'submission.json'
        def prepare(label):
            manifest.write_text(json.dumps(data));return stage_package(manifest,root/label)
        plan=prepare('one'); again=prepare('two')
        assert plan==again
        meta=plan['metadata'];assert meta['packageLayout']=='model-controls-source/1'
        assert [d['kind'] for d in meta['downloads']]==['model','controls','modeling-source']
        contents={}
        for name in ('model.zip','controls.zip','modeling-code.zip'):
            with ZipFile(root/'one'/name) as archive:
                assert archive.testzip() is None;contents[name]=set(archive.namelist())
                assert not {'secret.txt','submission.json'} & contents[name]
        assert contents['model.zip']=={'tank.glb','tank.usda','texture.png'}
        assert contents['controls.zip']=={'motion.py','native.py','controller.js','config.json','isaac-runtimes.json','ASSEMBLE_ISAAC.md','ASSEMBLE_GAME_ENGINE.md'}
        assert contents['modeling-code.zip']=={'build.py','order.json'}
        assert len([f for f in plan['files'] if f['destination']=='creator-releases'])==3
        assert not (root/'one/order.json').exists()
        host={'preview_base_url':'https://example.com/preview/','download_urls':{d['file']:'https://example.com/'+d['file'] for d in meta['downloads']},'repository_url':'https://example.com/repo'}
        entry=catalog_entry('test',plan,host)
        assert entry['isaacRuntimes']==['real-physics'] and entry['operableVehicle']
        assert [d['kind'] for d in entry['downloads']]==['model','controls','modeling-source']
        checkout=root/'catalog';checkout.mkdir();(checkout/'catalog.json').write_text('[]')
        assert add_to_catalog(checkout,'test',root/'one',plan,host)
        record=checkout/'_data/works/test.json';before=json.loads(record.read_text())
        before['social']={'discussion':123};record.write_text(json.dumps(before))
        assert not add_to_catalog(checkout,'test',root/'one',plan,host)
        updated=json.loads(json.dumps(plan));updated['metadata']['description']='New controls'
        assert add_to_catalog(checkout,'test',root/'one',updated,host)
        after=json.loads(record.read_text());assert after['publishedAt']==before['publishedAt'] and after['social']==before['social']
        assert len(after['downloads'])==3 and after['description']=='New controls'
        try:check_catalog_slot(checkout,'test',{**entry,'creator':'Someone Else'})
        except ValueError:pass
        else:raise AssertionError('creator replacement accepted')
        assert entry['vehicleController']['base']=='https://example.com/preview/preview/'
        for field,value in [('renderer','independent'),('thirdPersonCursor','visible')]:
            before=data['vehicleController'][field];data['vehicleController'][field]=value
            try:prepare('bad-'+field)
            except ValueError:pass
            else:raise AssertionError('invalid rendering policy accepted')
            data['vehicleController'][field]=before
        data['vehicleEntry']='drive.html'
        try:prepare('bad-iframe')
        except ValueError:pass
        else:raise AssertionError('independent HTML vehicle entry accepted')
        data.pop('vehicleEntry')
        data['isaacRuntimes']=['game']
        try:prepare('bad-runtime')
        except ValueError:pass
        else:raise AssertionError('missing Isaac entry accepted')
        data.pop('isaacRuntimes');data['controlFiles']=['../secret.txt']
        try:prepare('bad-path')
        except ValueError:pass
        else:raise AssertionError('path escape accepted')
        data.update(operableVehicle=False,previewFiles=['texture.png'],motionFiles=[],controlFiles=[])
        data.pop('vehicleController');data.pop('workOrder')
        static=prepare('static')
        assert len(static['metadata']['downloads'])==3 and not static['metadata']['operableVehicle']
        assert static['control_archive_contents']==['ASSEMBLE_GAME_ENGINE.md','ASSEMBLE_ISAAC.md']
    return {'passed':True,'checks':['three_archives','merge_without_collisions','preview_byte_identity','source_work_order_only','no_unlisted_files','deterministic_approval','runtime_entry_validation','path_validation','static_asset','role_metadata','replace_current_links_preserve_identity','reject_other_creator']}

if __name__=='__main__':
    print(json.dumps(run_check(),indent=2))
