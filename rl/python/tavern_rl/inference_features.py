"""CPU entity packing and lossless merging for shared inference requests."""
from dataclasses import dataclass
import numpy as np
import torch

from .features import pack_entities


INDEX_KEYS=('ids','group_owners','group_paths','field_groups','field_keys',
            'field_values','field_types','static_ids','static_owners')


@dataclass
class HostEntityBatch:
    data: dict

    @classmethod
    def prepare(cls, observations, schema, cache):
        packed=pack_entities(observations,schema,'cpu',definition_cache=cache)
        return cls({k:v.numpy() if isinstance(v,torch.Tensor) else v for k,v in packed.items()})

    def to(self, device):
        arrays=[self.data[k] for k in INDEX_KEYS]
        flat=torch.from_numpy(np.concatenate([x.reshape(-1) for x in arrays])).to(device)
        result={};offset=0
        for key,value in zip(INDEX_KEYS,arrays):
            result[key]=flat[offset:offset+value.size].reshape(value.shape);offset+=value.size
        return result | dict(strings=self.data['strings'],batch=self.data['batch'],
            owner_count=self.data['owner_count'],field_numbers=torch.from_numpy(self.data['field_numbers']).to(device))


def merge_batches(batches):
    """Merge numeric columns, keeping one copy of each static entity definition."""
    if len(batches)==1:return batches[0]
    packs=[b.data for b in batches];count=packs[0]['ids'].shape[1]
    if any(p['ids'].shape[1]!=count for p in packs):raise ValueError('Entity schema widths differ')
    batch=sum(p['batch'] for p in packs)
    identities=sorted({int(i) for p in packs for i in p['static_ids']})
    static={identity:batch*count+i for i,identity in enumerate(identities)}
    strings=[''];lookup={'':0};maps=[]
    for p in packs:
        mapping=[]
        for s in p['strings']:
            if s not in lookup:lookup[s]=len(strings);strings.append(s)
            mapping.append(lookup[s])
        maps.append(np.asarray(mapping,dtype=np.int64))
    columns={k:[] for k in ('group_owners','group_paths','field_groups','field_keys','field_values','field_types','field_numbers')}
    group_offset=0
    def append(index, selected, owners):
        nonlocal group_offset
        p=packs[index];mapping=maps[index]
        groups=np.flatnonzero(selected)
        if not len(groups):return
        renumber=np.full(len(selected),-1,dtype=np.int64);renumber[groups]=np.arange(len(groups))+group_offset
        fields=selected[p['field_groups']]
        columns['group_owners'].append(owners)
        columns['group_paths'].append(mapping[p['group_paths'][groups]])
        columns['field_groups'].append(renumber[p['field_groups'][fields]])
        for key in ('field_keys','field_values'):columns[key].append(mapping[p[key][fields]])
        for key in ('field_types','field_numbers'):columns[key].append(p[key][fields])
        group_offset+=len(groups)
    offset=0
    for i,p in enumerate(packs):
        selected=p['group_owners']<p['batch']*count
        append(i,selected,p['group_owners'][selected]+offset*count);offset+=p['batch']
    for identity in identities:
        for i,p in enumerate(packs):
            where=np.flatnonzero(p['static_ids']==identity)
            if len(where):
                selected=p['group_owners']==p['static_owners'][where[0]]
                append(i,selected,np.full(np.count_nonzero(selected),static[identity],dtype=np.int64));break
    result={k:np.concatenate(v) if v else np.empty((0,4) if k=='field_numbers' else (0,),dtype=np.float32 if k=='field_numbers' else np.int64) for k,v in columns.items()}
    if len(result['field_groups'])>2000000:raise ValueError('Merged inference batch exceeds two million fields')
    result.update(ids=np.concatenate([p['ids'] for p in packs]),strings=strings,batch=batch,
        owner_count=batch*count+len(identities),static_ids=np.asarray(identities,dtype=np.int64),
        static_owners=np.arange(batch*count,batch*count+len(identities),dtype=np.int64))
    return HostEntityBatch(result)
