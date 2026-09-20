export interface FlowElementWithId {
  id: string;
}

export const reconcileFlowElements = <Element extends FlowElementWithId>({
  current,
  projected,
  equals,
  merge,
}: {
  current: Element[];
  projected: readonly Element[];
  equals: (current: Element, projected: Element) => boolean;
  merge: (current: Element, projected: Element) => Element;
}): Element[] => {
  const currentById = new Map(current.map((element) => [element.id, element]));
  let changed = current.length !== projected.length;
  const next = projected.map((element, index) => {
    const previous = currentById.get(element.id);
    if (!previous) {
      changed = true;
      return element;
    }
    if (current[index]?.id !== element.id) changed = true;
    if (equals(previous, element)) return previous;
    changed = true;
    return merge(previous, element);
  });
  return changed ? next : current;
};
