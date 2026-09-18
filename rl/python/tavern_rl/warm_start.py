"""Copy trained core tensors into a plain PPO model for a new reward experiment."""
from .model import make_model

SPEC_HEADS = ('auxiliary_heads', 'card_value_head', 'action_values', 'scene_value_head', 'multi_horizon')
REMOVABLE = ('auxiliary', 'card_value_head', 'card_value_projection', 'card_value_type',
             'action_value_type', 'action_value_source', 'scene_current', 'scene_successor',
             'scene_target', 'scene_position', 'scene_fusion', 'horizon_embedding', 'horizon_mix',
             'horizon_economy', 'horizon_economy_target', 'horizon_economy_position', 'horizon_economy_fusion')


def plain_ppo_model(saved):
    spec = {key: value for key, value in saved['model_spec'].items() if key not in SPEC_HEADS}
    model = make_model(spec)
    expected = model.state_dict()
    missing = set(expected) - set(saved['model'])
    removed = set(saved['model']) - set(expected)
    unexpected = [key for key in removed if key.split('.')[0] not in REMOVABLE]
    if missing or unexpected:
        raise ValueError(f'Warm-start tensor mismatch: missing={sorted(missing)}, unexpected={sorted(unexpected)}')
    retained = {key: saved['model'][key] for key in expected}
    model.load_state_dict(retained, strict=True)
    # load_state_dict also checks all tensor shapes. Core parameters are copied,
    # not initialized anew; optimizer moments and the old reward config are not copied.
    return model, dict(source_iteration=saved.get('iteration'), source_episodes=saved.get('episodes'),
        source_depth=saved['model_spec'].get('policy_depth'), retained_tensors=len(retained),
        retained_parameters=sum(p.numel() for p in model.parameters()), removed_tensors=sorted(removed),
        removed_specification=[key for key in SPEC_HEADS if key in saved['model_spec']],
        optimizer='fresh', behavior_preserved=False)
