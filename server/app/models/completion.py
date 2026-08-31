from pydantic import BaseModel, ConfigDict


class CompletionResponse(BaseModel):
    """The `/complete` reply. Deliberately NOT ActionResponse.

    A completion judgement is a different kind of statement from an
    action proposal, and conflating them was the original mistake: the
    `done` action had to compete against seven concrete action types for
    the model's attention, and lost 0/235 times in measurement. This
    model carries no element, no value, no url — there is nothing here
    for a client to execute, by construction.

    `task_id` is copied from the VALIDATED request, never from model
    output. The model is asked one boolean question and is not trusted
    with identity: a model that could set task_id could attribute a
    completion verdict to a task the user never ran.

    `extra="forbid"` so no model-generated field can ride along.
    """

    model_config = ConfigDict(extra="forbid")

    complete: bool
    task_id: str
