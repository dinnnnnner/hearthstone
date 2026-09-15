"""Explicit PPO performance settings and migration away from unused-gold shaping."""
import argparse
import torch


def positive_size(value):
    value = int(value)
    if value < 1:
        raise argparse.ArgumentTypeError('Sequence batch size must be positive')
    return value


def add_arguments(parser):
    parser.add_argument('--training-graphs', action=argparse.BooleanOptionalAction, default=None,
                        help='Capture residual tower forward/backward during PPO')
    parser.add_argument('--sampling-processes', type=positive_size, default=1,
                        help='Separate on-policy sampler processes sharing one checkpoint')
    parser.add_argument('--resume-sequence-batch-size', type=positive_size,
                        help='Explicitly override the saved recurrent PPO batch')
    parser.add_argument('--fused-adam', action=argparse.BooleanOptionalAction, default=None,
                        help='Use fused CUDA Adam; omitted retains the checkpoint setting')


def apply_overrides(config, args):
    config.pop('unused_gold_penalty', None)
    config['reward_mode'] = 'placement_only'
    if getattr(args, 'training_graphs', None) is not None:
        config['training_graphs'] = args.training_graphs
    if args.resume_sequence_batch_size is not None:
        if not args.resume:
            raise ValueError('--resume-sequence-batch-size requires --resume')
        config['sequence_batch_size'] = args.resume_sequence_batch_size
    if args.fused_adam is not None:
        config['fused_adam'] = args.fused_adam


def make_optimizer(model, config, saved=None):
    parameters = list(model.parameters())
    fused = bool(config.get('fused_adam', False)) and all(p.is_cuda for p in parameters)
    optimizer = torch.optim.Adam(parameters, lr=config['learning_rate'], eps=1e-5,
                                 fused=True if fused else None)
    if saved is not None:
        # Set flags before loading: Adam uses them to place its step tensors.
        # Old param_groups otherwise silently overwrite the requested fused mode.
        state = dict(saved)
        state['param_groups'] = [dict(group, lr=config['learning_rate'],
                                     fused=True if fused else None, foreach=None)
                                 for group in saved['param_groups']]
        optimizer.load_state_dict(state)
    return optimizer


def make_pool(args, output):
    if args.sampling_processes > args.workers:
        raise ValueError('Sampling processes cannot exceed simulator workers')
    if args.sampling_processes > 1:
        from .process_rollout import ProcessSimulationPool
        return ProcessSimulationPool(args.workers,args.sampling_processes,output/'latest.pt')
    from .rollout import SimulationPool
    return SimulationPool(args.workers)


def optimized_update(update, model, optimizer, tracks, config, device):
    if not config.get('training_graphs', False) or torch.device(device).type != 'cuda':
        return update(model, optimizer, tracks, config, device)
    from .training_graphs import training_tower_graphs
    with training_tower_graphs(model) as graphs:
        result = update(model, optimizer, tracks, config, device)
        result.update(training_graphs=True, training_graph_count=sum(g.signature is not None for g in graphs),
                      training_graph_replays=sum(g.replays for g in graphs),
                      training_graph_capture_seconds=sum(g.capture_seconds for g in graphs))
    return result
