import numpy as np

def random_episode(simulator, seed, max_actions=16):
    """Diagnostics only; never a scripted training opponent."""
    rng = np.random.default_rng(seed)
    state = simulator.reset(seed, {"maxActionsPerTurn": max_actions})
    while not (state["terminated"] or state["truncated"]):
        state = simulator.step(rng.choice(state["legalActions"]))
    if state["truncated"]: raise RuntimeError("Diagnostic episode truncated")
    return state["info"]
