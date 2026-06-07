# nusika — weekly status dump (raw, unsorted)

Throwing everything from this week into one note so it's somewhere. Someone
should sort out what actually matters.

- The **media-server** started **crashing on startup (exit 1)** sometime after
  Tuesday's config refactor. It used to come up clean — last week's deploy was
  green and it was healthy. Right now nothing that depends on it can boot. This
  is the thing blocking us.

- The launch **trailer**'s **color grade still reads too cold** in the second
  half, and the **title-card font** was never finalized — production wants both
  locked before the final cut goes out.

- The **MiMo driver keeps hitting its token cap** (we see finish_reason=length)
  on the longer agent contexts, so long sessions get truncated mid-run. Feels
  like the engine's completion-token budget needs raising / rethinking.

- Side stuff, ignore probably: the office was freezing this morning, the coffee
  machine is almost out of beans again, and someone floated maybe reorganizing
  the wiki at some point. Also I think it might rain Thursday.
